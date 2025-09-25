const AWS = require("aws-sdk");
require("dotenv").config();

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRETE_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
  region: process.env.S3_AWS_REGION
});

const s3 = new AWS.S3();
const ses = new AWS.SES();
const sns = new AWS.SNS();
module.exports = {
  s3,
  ses,
  sns
};