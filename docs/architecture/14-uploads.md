# 14 — Files uploaded by the CEO (PDF, Excel, Word, images)

The CEO attaches files when messaging the CTO, on the web (the 📎 button, drag and drop, or paste) or via Telegram. Code is in
`src/upload/`.

## Decisions

- **Convert files to text once, on receipt.** Agents have no tool for reading binary files. Files are converted
  to text and saved as `uploads/<name>.md` documents, so `read`, `search` and path-based permissions work
  like for any other document. Employees assigned work by the CTO can also read those files by path.
- **Content travels with the message.** The CEO's message gets an extra `<attachments>` text part. Short files
  (≤ 12,000 characters) are included verbatim. Long files include only the first 2,000 characters plus instructions to read
  on with `read(path, offset, limit)`, so a large Excel sheet does not fill the context.
- **Images go straight to the model** (part `image`; Anthropic `image`, OpenAI `image_url` data URL). Images
  are not saved as documents. Models without image support return an error from the provider.
- **Libraries:** only `unpdf` (prebundled pdf.js, no native dependencies) is added, for PDF. Excel and Word
  are zip + XML, so they are read with `node:zlib` (`zip.ts`) and regex on the XML.
  - Excel becomes CSV per sheet. Dates stay as serial numbers; the agent is told about this.
  - Word becomes paragraphs, headings become `#`, tables become `| a | b |`.
- Scanned PDFs (no text layer) are reported clearly so the CEO can send them as images. No OCR yet.
- **Limits:** 20 MB per file, 5 MB per image; JSON body up to ~110 MB (files are sent as base64 in JSON,
  no multipart needed). Telegram only lets bots download files ≤ 20 MB.
- Unsupported file types (`.doc`, legacy `.xls`, `.exe`…) are rejected with a Vietnamese message. The message
  is not sent, so the CEO can fix it and resend.
- The original of every file is also saved into the `bash` working directory (`uploads/<name>`) so code can compute exactly (`15-bash.md`).
- Name collisions do not overwrite: the new file becomes `uploads/bao-cao.pdf (2).md`.
- UI: the message shows a file list (links to the **Results** (Kết quả) page → "Files you sent" (File bạn gửi)) and image thumbnails instead of
  the `<attachments>` block.

## Not done yet

- OCR for scanned PDFs, `.doc`/`.xls`/`.pptx` files.
