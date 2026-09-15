import express from "express"
import multer from "multer"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { spawn } from "child_process"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"

const app = express()

const allowedOrigins = [
  "https://matbatukapp.netlify.app",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175"
]

app.use((req, res, next) => {
  const origin = req.headers.origin

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*")
  }

  res.setHeader("Vary", "Origin")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin, X-Requested-With")
  res.setHeader("Access-Control-Max-Age", "86400")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`)
  next()
})

const upload = multer({
  dest: "/tmp",
  limits: {
    fileSize: 1024 * 1024 * 1000
  }
})

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_URL
} = process.env

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
})

function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", inputPath,

      "-map", "0:v:0",
      "-map", "0:a?",
      "-sn",

      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-profile:v", "high",
      "-level", "4.2",

      "-c:a", "aac",
      "-b:a", "192k",
      "-ac", "2",

      "-movflags", "+faststart",
      outputPath
    ]

    console.log("FFmpeg command:", args.join(" "))

    const ffmpeg = spawn("ffmpeg", args)

    let stderr = ""

    ffmpeg.stderr.on("data", data => {
      const text = data.toString()
      stderr += text
      console.log(text.slice(-500))
    })

    ffmpeg.on("error", reject)

    ffmpeg.on("close", code => {
      console.log("FFmpeg closed with code:", code)

      if (code === 0) {
        resolve()
      } else {
        reject(new Error(stderr || `ffmpeg exited with ${code}`))
      }
    })
  })
}

function sanitizeName(name = "video") {
  return String(name)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/\.(mov|mp4|m4v|quicktime)$/i, "")
    .slice(0, 70) || "video"
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Matbatuk video converter",
    usage: "POST /convert with multipart field file"
  })
})

app.post("/convert", upload.single("file"), async (req, res) => {
  console.log("POST /convert received")

  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: "No file uploaded"
    })
  }

  const inputPath = req.file.path
  const outputName = `${sanitizeName(req.file.originalname)}-${crypto.randomUUID()}.mp4`
  const outputPath = path.join("/tmp", outputName)

  try {
    console.log("Original file:", req.file.originalname)
    console.log("Original size MB:", (req.file.size / 1024 / 1024).toFixed(2))
    console.log("Converting high quality:", req.file.originalname)

    await runFfmpeg(inputPath, outputPath)

    const outputStats = await fs.promises.stat(outputPath)

    console.log("Conversion done:", outputName)
    console.log("Output size MB:", (outputStats.size / 1024 / 1024).toFixed(2))

    const now = new Date().toISOString().slice(0, 10)
    const key = `videos/${now}/${outputName}`

    console.log("Uploading to R2:", key)

    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: fs.createReadStream(outputPath),
      ContentType: "video/mp4"
    }))

    const publicBase = R2_PUBLIC_URL.replace(/\/$/, "")
    const finalUrl = `${publicBase}/${key}`

    console.log("Uploaded to R2:", finalUrl)

    res.json({
      ok: true,
      key,
      url: finalUrl,
      contentType: "video/mp4",
      fileName: outputName
    })
  } catch (error) {
    console.error("Conversion failed:", error)

    res.status(500).json({
      ok: false,
      error: "Conversion failed",
      message: error.message
    })
  } finally {
    fs.promises.unlink(inputPath).catch(() => {})
    fs.promises.unlink(outputPath).catch(() => {})
  }
})

app.use((err, req, res, next) => {
  console.error("Server error:", err)

  res.status(500).json({
    ok: false,
    error: "Server error",
    message: err.message
  })
})

const port = process.env.PORT || 3000

app.listen(port, () => {
  console.log(`Matbatuk converter running on port ${port}`)
})
