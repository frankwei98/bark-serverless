export function isJsonContentType(contentType: string | null | undefined): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || /^application\/[^\s/]+\+json$/.test(mediaType);
}
