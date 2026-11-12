import express from "express"
import multer from "multer"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { spawn } from "child_process"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"

// مطبعتك — سيرفر تحويل فيديو الإدارة (MOV ← MP4 بدون فقدان جودة) ورفعه لـ R2.
// حماية (2026-11-12): يقبل بس طلبات الأدمن. موقع مطبعتك (/api/admin/converter) يعطي الأدمن "تذكرة"
// موقّعة بـ CONVERTER_SECRET تنتهي بعد 15 دقيقة، وهنا نتأكد منها قبل ما نستلم الملف.
// إذا CONVERTER_SECRET مو موجود بـ Environment، السيرفر يشتغل مثل قبل (حتى ما ينقطع التحويل وقت التبديل).

const app = express()
app.disable("x-powered-by")

const allowedOrigins = [
  /^https:\/\/(www\.)?matbatuk\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/
]

app.use((req, res, next) => {
  const origin = req.headers.origin || ""
  const ok = allowedOrigins.some(re => re.test(origin))
  res.setHeader("Access-Control-Allow-Origin", ok ? origin : "https://matbatuk.com")
  res.setHeader("Vary", "Origin")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin, X-Requested-With")
  res.setHeader("Access-Control-Max-Age", "86400")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`)
  next()
})

const MAX_BYTES = 1024 * 1024 * 1000

const upload = multer({
  dest: "/tmp",
  limits: {
    fileSize: MAX_BYTES,
    files: 1,
    fields: 5
  }
})

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_URL,
  R2_ENDPOINT,
  CONVERTER_SECRET
} = process.env

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: Boolean(R2_ENDPOINT),
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
})

// ---------- التذكرة ----------
// الشكل: v1.<exp ثواني>.<hex HMAC-SHA256(secret, "v1.<exp>")> — نفس worker/converter.js بموقع مطبعتك
const MAX_TOKEN_AGE = 60 * 60

export function verifyToken(token, secret, nowMs = Date.now()) {
  const m = /^v1\.(\d{9,11})\.([0-9a-f]{64})$/.exec(String(token || ""))
  if (!m || !secret) return false
  const exp = Number(m[1])
  const now = Math.floor(nowMs / 1000)
  if (exp < now || exp - now > MAX_TOKEN_AGE) return false
  const want = crypto.createHmac("sha256", secret).update(`v1.${exp}`).digest()
  const got = Buffer.from(m[2], "hex")
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

function requireTicket(req, res, next) {
  if (!CONVERTER_SECRET || CONVERTER_SECRET.length < 16) return next()
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim()
  if (verifyToken(token, CONVERTER_SECRET)) return next()
  // نرفض قبل ما نستلم الملف، ونسكّر الاتصال حتى ما يكمل يرفع
  res.setHeader("Connection", "close")
  return res.status(401).json({ ok: false, error: "Unauthorized" })
}

// ---------- التحويل ----------
function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-hide_banner",
      // ملفات الفيديو العادية بس (MOV/MP4/M4V/WebM)، ولا يفتح أي ملف أو رابط ثاني من داخل الفيديو
      "-protocol_whitelist", "file",
      "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm",
      "-i", inputPath,

      "-map", "0:v:0",
      "-map", "0:a?",
      "-sn",
      "-dn",
      "-map_metadata", "-1",

      "-c", "copy",
      "-movflags", "+faststart",

      outputPath
    ]

    const ffmpeg = spawn("ffmpeg", args)

    let stderr = ""

    ffmpeg.stderr.on("data", data => {
      stderr = (stderr + data.toString()).slice(-4000)
    })

    ffmpeg.on("error", reject)

    ffmpeg.on("close", code => {
      console.log("FFmpeg closed with code:", code)

      if (code === 0) {
        resolve()
      } else {
        console.error(stderr.slice(-1500))
        reject(new Error(`ffmpeg exited with ${code}`))
      }
    })
  })
}

function sanitizeName(name = "video") {
  return String(name)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/\.(mov|mp4|m4v|webm|quicktime)$/i, "")
    .slice(0, 70) || "video"
}

app.get("/", (req, res) => {
  res.json({ ok: true })
})

app.post("/convert", requireTicket, upload.single("file"), async (req, res) => {
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
    console.log("Size MB:", (req.file.size / 1024 / 1024).toFixed(2))

    await runFfmpeg(inputPath, outputPath)

    const now = new Date().toISOString().slice(0, 10)
    const key = `videos/${now}/${outputName}`

    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: fs.createReadStream(outputPath),
      ContentType: "video/mp4"
    }))

    const publicBase = String(R2_PUBLIC_URL || "").replace(/\/$/, "")
    const finalUrl = `${publicBase}/${key}`

    console.log("Uploaded:", key)

    res.json({
      ok: true,
      key,
      url: finalUrl,
      contentType: "video/mp4",
      fileName: outputName
    })
  } catch (error) {
    console.error("Conversion failed:", error.message)

    res.status(500).json({
      ok: false,
      error: "Conversion failed",
      message: "ما كدرنا نحوّل هذا الفيديو. تأكد إنه فيديو MOV أو MP4 سليم."
    })
  } finally {
    fs.promises.unlink(inputPath).catch(() => {})
    fs.promises.unlink(outputPath).catch(() => {})
  }
})

app.use((err, req, res, next) => {
  if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {})
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, error: "File too large", message: "الفيديو أكبر من 1GB." })
  }
  console.error("Server error:", err?.message)
  res.status(500).json({
    ok: false,
    error: "Server error",
    message: "صار خطأ بالسيرفر. جرّب مرة ثانية."
  })
})

const port = process.env.PORT || 3000

if (process.env.CONVERTER_NO_LISTEN !== "1") {
  app.listen(port, () => {
    console.log(`Matbatuk converter running on port ${port}${CONVERTER_SECRET ? " (locked)" : " (OPEN: set CONVERTER_SECRET)"}`)
  })
}

export default app
