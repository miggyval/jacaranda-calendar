// Trigger a browser download for a Blob via a transient object URL.
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Trigger a browser download for text content (defaults to iCalendar).
export function downloadTextFile(filename: string, text: string, mime = "text/calendar;charset=utf-8") {
  downloadBlob(filename, new Blob([text], { type: mime }));
}
