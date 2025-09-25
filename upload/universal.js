const { s3 } = require("../config/upload");
const AWS = require("aws-sdk");
const multer = require("multer");

const rekognition = new AWS.Rekognition();
const comprehend = new AWS.Comprehend();
const textract = new AWS.Textract();

const uploadMiddleware = multer().single("file");

// This is needed for image analysis
const analyzeWithRekognition = async (bucket, key) => {
    const params = {
      Image: {
        S3Object: {
          Bucket: bucket,
          Name: key,
        },
      },
    };
    const response = await rekognition.detectModerationLabels(params).promise();
    return response.ModerationLabels.filter(label => label.Confidence > 90);
  };
  
  // This is needed for video analysis
  const videoanalyzeWithRekognition = async (bucket, key) => {
    const params = {
      Video: {
        S3Object: {
          Bucket: bucket,
          Name: key,
        },
      },
    };
  
    try {
      // Step 1: Start label detection
      const startResponse = await rekognition.startContentModeration(params).promise();
      const jobId = startResponse.JobId;
  
      // Step 2: Poll for results (wait for the analysis to complete)
      let result;
      while (true) {
        const getParams = { JobId: jobId };
        const getResponse = await rekognition.getContentModeration(getParams).promise();
  
        if (getResponse.JobStatus === "SUCCEEDED") {
          result = getResponse.ModerationLabels || []; // Default to empty array if no labels
          break;
        } else if (getResponse.JobStatus === "FAILED") {
          throw new Error("Video analysis failed");
        }
  
        // Wait for a few seconds before polling again
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
  
      // Step 3: Filter results for high-confidence labels
      return result
        .filter((label) => label.Label && label.Label.Confidence > 90)
        .map((label) => ({
          Name: label.Label.Name,
          Confidence: label.Label.Confidence,
        }));
    } catch (error) {
      console.error("Error during video analysis:", error);
      throw error; // Re-throw the error after logging it
    }
  };
  
  //This step is common for all 3
  const analyzeWithComprehend = async (text, bucket, key) => {
    const params = {
      TextSegments: [{ Text: text }],
      LanguageCode: "en",
    };
  
    try {
      const response = await comprehend.detectToxicContent(params).promise();
      console.log("Comprehend Toxic Content Analysis Response:", response);
  
      if (response && response.ResultList && response.ResultList.length > 0) {
        const result = response.ResultList[0]; // Assuming single segment analysis
        const toxicity = result.Toxicity || 0; // Default to 0 if not found
  
        console.log("Toxicity Confidence Score:", toxicity);
  
        // Return the toxicity level and other details for further handling
        return { toxicity, result };
      }
  
      return { toxicity: 0 }; // No toxicity detected
    } catch (error) {
      console.error("Error analyzing with Comprehend:", error);
      throw error;
    }
  };
      
  //This step is needed for pdf file analysis
  const extractTextFromImage = async (bucket, key) => {
    const params = {
      Document: {
        S3Object: {
          Bucket: bucket,
          Name: key,
        },
      },
    };
    const response = await textract.detectDocumentText(params).promise();
  return response.Blocks.filter(block => block.BlockType === "LINE").map(block => block.Text).join(" ");
};  

const analyzeFile = async (file, bucket, key) => {
  const fileType = file.mimetype;

  if (fileType.startsWith("image/")) {
    // Image Analysis
    const violations = await analyzeWithRekognition(bucket, key);

    if (violations.length > 0) {
      await s3.deleteObject({ Bucket: bucket, Key: key }).promise();
      return { success: false, error: "Content violation detected", violations };
    }

    const extractedText = await extractTextFromImage(bucket, key);
    if (extractedText) {
      const sentiment = await analyzeWithComprehend(extractedText);
      if (sentiment === "NEGATIVE") {
        await s3.deleteObject({ Bucket: bucket, Key: key }).promise();
        return { success: false, error: "Negative sentiment detected in content" };
      }
    }
  } else if (fileType.startsWith("video/")) {
    // Video Analysis
    const violations = await videoanalyzeWithRekognition(bucket, key);

    if (violations.length > 0) {
      await s3.deleteObject({ Bucket: bucket, Key: key }).promise();
      return { success: false, error: "Content violation detected", violations };
    }
  } else if (fileType === "application/pdf") {
    // PDF Analysis
    const extractedText = await extractTextFromImage(bucket, key);
    if (extractedText) {
        const toxicResponse = await analyzeWithComprehend(extractedText);
        // Check if toxicResponse contains ResultList and Labels
        // Check toxicity level and delete the file if above 0.75
        if (toxicResponse.toxicity > 0.75) {
            console.log("Toxicity level exceeds threshold. Flagging for deletion.");
        
            // Delete the file from S3 if toxicity is above 0.75
            await s3.deleteObject({ Bucket: bucket, Key: key }).promise();

            return {
                success: false,
                error: "Toxic content detected and file deleted",
                details: toxicResponse.result,
            }
        }
  }
  } else {
    return { success: false, error: "Unsupported file type" };
  }

  return { success: true };
};

const universalUpload = async (req, res) => {
  try {
    uploadMiddleware(req, res, async (err) => {
      if (!req.file) {
        return res.status(400).json({ error: "Please provide a file" });
      }

      if (err) {
        return res.status(400).json({ error: err.message });
      }

      const { key = "Worktool" } = req.body || {};
      const s3Params = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: `${key}/${req.file.originalname}`,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      };

      const uploadedFile = await s3.upload(s3Params).promise();
      const analysisResult = await analyzeFile(req.file, process.env.AWS_BUCKET_NAME, uploadedFile.Key);

      if (!analysisResult.success) {
        return res.status(400).json(analysisResult);
      }

      res.status(200).json({
        message: "File uploaded and passed moderation successfully",
        fileUrl: `${process.env.CLOUDFRONT_BASE_URL}${uploadedFile.Key}`,
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  universalUpload,
};
