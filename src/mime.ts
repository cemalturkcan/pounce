const TEXTUAL_MIME =
  /^\s*(text\/|application\/(json|javascript|ecmascript|xml|x-www-form-urlencoded|graphql|ld\+json|[\w.+-]*\+json|[\w.+-]*\+xml)\b|image\/svg\+xml)/i;

export function isTextualMime(contentType: string | undefined) {
  return TEXTUAL_MIME.test(contentType ?? "");
}

export function isStreamingMime(contentType: string | undefined) {
  return /^\s*text\/event-stream/i.test(contentType ?? "");
}
