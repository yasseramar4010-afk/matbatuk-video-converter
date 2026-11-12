// فحص سيرفر التحويل: node test.mjs (يحتاج ffmpeg). R2 مزيّف محلي. ما يحتاج إنترنت.
import http from "http"
import fs from "fs"
import os from "os"
import path from "path"
import crypto from "crypto"
import { execFileSync } from "child_process"

const SITE_TOKEN = process.env.SITE_CONVERTER_JS // اختياري: worker/converter.js مال الموقع حتى نتأكد التذكرتين متطابقات

const puts = []
const fakeR2 = http.createServer((req, res) => {
  let size = 0
  req.on("data", c => { size += c.length })
  req.on("end", () => { puts.push({ method: req.method, url: req.url, size }); res.writeHead(200, { ETag: '"x"' }); res.end() })
})
await new Promise(r => fakeR2.listen(0, "127.0.0.1", r))

const SECRET = crypto.randomBytes(32).toString("hex")
Object.assign(process.env, {
  CONVERTER_NO_LISTEN: "1", CONVERTER_SECRET: SECRET,
  R2_ENDPOINT: `http://127.0.0.1:${fakeR2.address().port}`, R2_BUCKET: "bucket",
  R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s", R2_PUBLIC_URL: "https://pub.example.r2.dev/"
})
const { default: app, verifyToken } = await import("./server.js?locked")
const server = app.listen(0, "127.0.0.1")
await new Promise(r => server.once("listening", r))
const base = `http://127.0.0.1:${server.address().port}`

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conv-"))
const mov = path.join(tmp, "clip.mov")
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
  "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "libx264", "-c:a", "aac", "-shortest", mov])
const evil = path.join(tmp, "evil.mov")
fs.writeFileSync(evil, "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n")

const tokenFor = (secret, exp) => `v1.${exp}.${crypto.createHmac("sha256", secret).update(`v1.${exp}`).digest("hex")}`
const now = () => Math.floor(Date.now() / 1000)
const good = tokenFor(SECRET, now() + 900)

async function send(file, token, origin = "https://matbatuk.com") {
  const form = new FormData()
  form.append("file", new Blob([fs.readFileSync(file)]), path.basename(file))
  const headers = { origin }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${base}/convert`, { method: "POST", headers, body: form })
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers }
}

let pass = 0, fail = 0
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}`) }

let r = await send(mov, null)
check("no ticket → 401", r.status === 401 && puts.length === 0)
r = await send(mov, "v1.123.abc")
check("garbage ticket → 401", r.status === 401)
r = await send(mov, tokenFor("wrong-secret-wrong-secret", now() + 900))
check("ticket signed with another secret → 401", r.status === 401)
r = await send(mov, tokenFor(SECRET, now() - 5))
check("expired ticket → 401", r.status === 401)
r = await send(mov, tokenFor(SECRET, now() + 5 * 3600))
check("ticket too far in the future → 401", r.status === 401)
check("nothing reached R2 so far", puts.length === 0)

r = await send(mov, good)
check("admin ticket → converted", r.status === 200 && r.body?.ok && /^videos\/\d{4}-\d\d-\d\d\/clip-[0-9a-f-]{36}\.mp4$/.test(r.body.key))
check("public url built", r.body?.url === `https://pub.example.r2.dev/${r.body?.key}`)
check("one PUT to R2 with data", puts.length === 1 && puts[0].method === "PUT" && puts[0].size > 1000 && puts[0].url.includes("/bucket/videos/"))

r = await send(evil, good)
check("playlist pretending to be a video → rejected, nothing uploaded", r.status === 500 && puts.length === 1)
check("error hides ffmpeg details", !/passwd|ffmpeg|EXTM3U/i.test(JSON.stringify(r.body)))

r = await send(mov, good, "https://evil.example")
check("foreign origin not echoed", r.headers.get("access-control-allow-origin") === "https://matbatuk.com")
const pre = await fetch(`${base}/convert`, { method: "OPTIONS", headers: { origin: "https://www.matbatuk.com" } })
check("preflight allows Authorization", pre.status === 200 && /authorization/i.test(pre.headers.get("access-control-allow-headers")) && pre.headers.get("access-control-allow-origin") === "https://www.matbatuk.com")
const home = await (await fetch(`${base}/`)).json()
check("home says nothing about usage", JSON.stringify(home) === '{"ok":true}')

if (SITE_TOKEN) {
  const { converterToken } = await import(SITE_TOKEN)
  const t = await converterToken(SECRET)
  check("site ticket (worker/converter.js) accepted here", verifyToken(t.token, SECRET))
  r = await send(mov, t.token)
  check("site ticket converts end-to-end", r.status === 200)
  check("site refuses short secret", (await converterToken("short")) === null)
}

server.close()

// بدون CONVERTER_SECRET: يشتغل مثل قبل (حتى التبديل ما يقطع التحويل)
delete process.env.CONVERTER_SECRET
const { default: openApp } = await import("./server.js?open")
const s2 = openApp.listen(0, "127.0.0.1")
await new Promise(r2 => s2.once("listening", r2))
const form = new FormData()
form.append("file", new Blob([fs.readFileSync(mov)]), "clip.mov")
const r3 = await fetch(`http://127.0.0.1:${s2.address().port}/convert`, { method: "POST", body: form })
check("without CONVERTER_SECRET still works (rollout safety)", r3.status === 200)
s2.close()
fakeR2.close()
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
