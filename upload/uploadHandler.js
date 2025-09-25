const { s3 } = require("../config/upload");
const AWS = require("aws-sdk");
const multer = require("multer");

const rekognition = new AWS.Rekognition();
const comprehend = new AWS.Comprehend();
const textract = new AWS.Textract();

const uploadImageMiddleware = multer().single("image");
const uploadPDFMiddleware = multer().single("file");
const uploadMultiple = multer().array("media");

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

// Image Analysis using Amazon Rekognition
const uploadPicture = async (file, key) => {
  const s3Params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: `${key}/${file.originalname}`,
    Body: file.buffer,
    ContentType: file.mimetype,
  };
  const result = await s3.upload(s3Params).promise();
  return result;
};

const uploadImage = async (req, res) => {
  try {
    uploadImageMiddleware(req, res, async (err) => {
      if (!req.file) {
        return res.status(400).json({ error: "Please provide an image" });
      }

      if (err) {
        return res.status(400).json({ error: err.message });
      }

      const { key = "Worktool" } = req.body || {};
      const uploadedFile = await uploadPicture(req.file, key);

      const violations = await analyzeWithRekognition(process.env.AWS_BUCKET_NAME, uploadedFile.Key);

      if (violations.length > 0) {
        await s3.deleteObject({ Bucket: process.env.AWS_BUCKET_NAME, Key: uploadedFile.Key }).promise();
        return res.status(400).json({ error: "Content violation detected", violations });
      }

      const extractedText = await extractTextFromImage(process.env.AWS_BUCKET_NAME, uploadedFile.Key);
      if (extractedText) {
        const sentiment = await analyzeWithComprehend(extractedText);
        if (sentiment === "NEGATIVE") {
          await s3.deleteObject({ Bucket: process.env.AWS_BUCKET_NAME, Key: uploadedFile.Key }).promise();
          return res.status(400).json({ error: "Negative sentiment detected in content" });
        }
      }

      res.status(200).json({ message: "Image uploaded and passed moderation successfully", image: `${process.env.CLOUDFRONT_BASE_URL}${uploadedFile.Key}` });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// PDF File Analysis using Amazon Textract and Comprehend
const uploadPDF = async (req, res) => {
  try {
    uploadPDFMiddleware(req, res, async (err) => {
      if (!req.file) {
        return res.status(400).json({ error: "Please provide a PDF file" });
      }

      if (err) {
        return res.status(400).json({ error: err.message });
      }

      const { key = "Worktool" } = req.body || {};
      const uploadedFile = await uploadPicture(req.file, key);

      const extractedText = await extractTextFromImage(process.env.AWS_BUCKET_NAME, uploadedFile.Key);
      if (extractedText) {
        const toxicResponse = await analyzeWithComprehend(extractedText);
        // Check if toxicResponse contains ResultList and Labels
        // Check toxicity level and delete the file if above 0.75
        if (toxicResponse.toxicity > 0.75) {
            console.log("Toxicity level exceeds threshold. Flagging for deletion.");
        
            // Delete the file from S3 if toxicity is above 0.75
            await s3.deleteObject({ Bucket: process.env.AWS_BUCKET_NAME, Key: uploadedFile.Key }).promise();

            return res.status(400).json({
              success: false,
              error: "Toxic content detected and file deleted",
              details: toxicResponse.result,
            });
          }
        }

      res.status(200).json({ message: "PDF uploaded and passed moderation successfully", pdf: `${process.env.CLOUDFRONT_BASE_URL}${uploadedFile.Key}` });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Video Analysis using Amazon Rekognition
const uploadMedia = async (files, key) => {
  const pictures = files?.map((file) => {
    const s3Params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: `${key}/${file.originalname}`,
      Body: file.buffer,
      ContentType: file.mimetype,
    };

    return s3.upload(s3Params).promise();
  });

  const results = await Promise?.all(pictures);
  return results;
};

const uploadVideo = async (req, res) => {
  try {
    uploadMultiple(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }

      if (!req.files || (req.files && req.files.length <= 0)) {
        return res.status(400).json({ error: "Please provide the media to upload" });
      }

      const { key = "Worktool" } = req.body || {};
      const uploadedFiles = await uploadMedia(req.files, key);

      // Process each uploaded file
      for (const file of uploadedFiles) {
        const fileKey = file.Key; // Extract the S3 Key of the current file

        // Call Rekognition for video analysis
        const violations = await videoanalyzeWithRekognition(process.env.AWS_BUCKET_NAME, fileKey);

        if (violations.length > 0) {
          // Delete the violating file
          await s3.deleteObject({ Bucket: process.env.AWS_BUCKET_NAME, Key: fileKey }).promise();
          return res.status(400).json({ error: "Content violation detected", violations });
        }
      }

      // Respond with success and uploaded file URLs
      res.status(200).json({
        message: "Media uploaded and passed moderation successfully",
        data: uploadedFiles.map((file) => `${process.env.CLOUDFRONT_BASE_URL}${file.Key}`),
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Upload any file

const uploadMultipleFiles = async (req, res) => {
  try {
    const uploadMiddleware = multer().array("file"); // Use a single middleware for "file"

    uploadMiddleware(req, res, async (err) => {
      if (!req.file) {
        return res.status(400).json({ error: "Please provide a file to upload" });
      }

      if (err) {
        return res.status(400).json({ error: err.message });
      }

      const { key = "Worktool" } = req.body || {};
      const uploadedFile = await uploadPicture(req.file, key); // Common upload function

      const fileType = req.file.mimetype;

      if (fileType.startsWith("image/")) {
        // Image moderation
        const violations = await analyzeWithRekognition(process.env.AWS_BUCKET_NAME, uploadedFile.Key);

        if (violations.length > 0) {
          await s3.deleteObject({ Bucket: process.env.AWS_BUCKET_NAME, Key: uploadedFile.Key }).promise();
          return res.status(400).json({ error: "Content violation detected in image", violations });
        }
      } else if (fileType === "application/pdf") {
        // PDF moderation
        const extractedText = await extractTextFromImage(process.env.AWS_BUCKET_NAME, uploadedFile.Key);

        if (extractedText) {
          const toxicResponse = await analyzeWithComprehend(extractedText);

          if (toxicResponse.toxicity > 0.75) {
            await s3.deleteObject({ Bucket: process.env.AWS_BUCKET_NAME, Key: uploadedFile.Key }).promise();
            return res.status(400).json({
              error: "Toxic content detected in PDF and file deleted",
              details: toxicResponse.result,
            });
          }
        }
      } else if (fileType.startsWith("video/")) {
        // Video moderation
        const violations = await videoanalyzeWithRekognition(process.env.AWS_BUCKET_NAME, uploadedFile.Key);

        if (violations.length > 0) {
          await s3.deleteObject({ Bucket: process.env.AWS_BUCKET_NAME, Key: uploadedFile.Key }).promise();
          return res.status(400).json({ error: "Content violation detected in video", violations });
        }
      } else {
        // Unsupported file type
        await s3.deleteObject({ Bucket: process.env.AWS_BUCKET_NAME, Key: uploadedFile.Key }).promise();
        return res.status(400).json({ error: "Unsupported file type" });
      }

      // Respond with success and uploaded file URL
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
  uploadImage, //Upload image file
  uploadPDF, //Upload PDF file
  uploadVideo, //Upload video file
  uploadMultipleFiles, //Upload Any file
};