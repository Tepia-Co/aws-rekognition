require("dotenv").config();
const express = require("express");
const { uploadImage, uploadPDF, uploadMultipleFiles, uploadVideo } = require("./upload/uploadHandler");
const { universalUpload } = require("./upload/universal.js");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/test/test.html', (req, res) => {
    res.sendFile(__dirname + '/test/test.html'); // Assuming the file is in the 'public' directory
});

// Routes
app.post("/upload/image", uploadImage);
app.post("/upload/pdf", uploadPDF);
app.post("/upload/multiple", uploadMultipleFiles);
app.post("/upload/video", uploadVideo);
app.post("/upload/uni", universalUpload);
// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
