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

## Start locally

```bash
npm install
npm start
```
