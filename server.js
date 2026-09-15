import express from "express"
import multer from "multer"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { spawn } from "child_process"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"

const app = express()

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`)
  next()
})

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization")
  if (req.method === "OPTIONS") return res.sendStatus(200)
  next()
})

const upload = multer({
  dest: "/tmp",
  limits: {
    fileSize: 1024 * 1024 * 700
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
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outputPath
    ]

    const ffmpeg = spawn("ffmpeg", args)

    let stderr = ""

    ffmpeg.stderr.on("data", data => {
      stderr += data.toString()
    })

    ffmpeg.on("error", reject)

    ffmpeg.on("close", code => {
      if (code === 0) resolve()
      else reject(new Error(stderr || `ffmpeg exited with ${code}`))
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
    return res.status(400).json({ error: "No file uploaded" })
  }

  const inputPath = req.file.path
  const outputName = `${sanitizeName(req.file.originalname)}-${crypto.randomUUID()}.mp4`
  const outputPath = path.join("/tmp", outputName)

  try {
    console.log("Converting:", req.file.originalname)

    await runFfmpeg(inputPath, outputPath)

    console.log("Conversion done:", outputName)

    const now = new Date().toISOString().slice(0, 10)
    const key = `videos/${now}/${outputName}`

    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: fs.createReadStream(outputPath),
      ContentType: "video/mp4"
    }))

    const publicBase = R2_PUBLIC_URL.replace(/\/$/, "")

    res.json({
      ok: true,
      key,
      url: `${publicBase}/${key}`,
      contentType: "video/mp4",
      fileName: outputName
    })
  } catch (error) {
    console.error("Conversion failed:", error)
    res.status(500).json({
      error: "Conversion failed",
      message: error.message
    })
  } finally {
    fs.promises.unlink(inputPath).catch(() => {})
    fs.promises.unlink(outputPath).catch(() => {})
  }
})

const port = process.env.PORT || 3000

app.listen(port, () => {
  console.log(`Matbatuk converter running on port ${port}`)
})
