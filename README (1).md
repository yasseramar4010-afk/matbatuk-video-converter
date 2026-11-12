# Matbatuk Video Converter

Express + FFmpeg API for converting iPhone MOV videos to MP4 H.264/AAC and uploading to Cloudflare R2.

## Endpoint

POST `/convert`

Multipart form field:

- `file`: MOV/MP4 video file

## Environment variables

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `R2_PUBLIC_URL`
- `CONVERTER_SECRET` — نفس قيمة الـ Worker secret بموقع مطبعتك. بدونه السيرفر يقبل من أي واحد.

## Security

`POST /convert` needs `Authorization: Bearer v1.<exp>.<hmac>` — a 15-minute ticket the admin gets from
`https://matbatuk.com/api/admin/converter` (HMAC-SHA256 of `v1.<exp>` with `CONVERTER_SECRET`).
Requests without a valid ticket are refused before the file is received. ffmpeg only opens MOV/MP4/WebM
(`-format_whitelist`, `-protocol_whitelist file`).

Test: `npm install && node test.mjs` (needs ffmpeg).

## Start locally

```bash
npm install
npm start
```
