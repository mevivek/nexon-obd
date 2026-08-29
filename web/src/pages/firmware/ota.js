// OTA upload logic, ported from the <script> in firmware/Obdurate/ota_html.h.
//
// Split out from the page so the parts that decide what the driver is told — did it
// flash, how far along is it — can be asserted on the host rather than by flashing a
// board and watching. The XHR itself stays in the page; only its verdicts live here.

/**
 * Did the board accept the image?
 *
 * `try{ok=JSON.parse(x.responseText).ok}catch(e){}` — the firmware answers
 * {"ok":true} on a verified write, and anything else (a plain-text error from
 * Update.printError, an empty body from a connection that died between the last
 * byte and the reply) is a failure. Non-JSON must never read as success: the board
 * is about to reboot or not, and guessing wrong tells someone their car's ECU
 * interface is flashed when it is not.
 */
export function otaOk(responseText) {
  try {
    return !!JSON.parse(responseText).ok;
  } catch (e) {
    return false;
  }
}

/** Upload progress as a CSS width. Only called while e.lengthComputable. */
export function progressPct(loaded, total) {
  return total > 0 ? (100 * loaded / total).toFixed(0) + '%' : '0%';
}

/** `Uploading 1234 KB...` — truncated, matching the firmware's `file.size/1024|0`. */
export function uploadingText(size) {
  return 'Uploading ' + (size / 1024 | 0) + ' KB...';
}

/** What the page says while and after the upload. Wording is the firmware's. */
export const OTA_MSG = {
  ok: 'Flashed. Rebooting - reconnect to Obdurate in a few seconds.',
  lost: 'Connection lost during upload.',
};

/** A failure carries the board's own words, because they say which check refused. */
export function otaFailText(responseText) {
  return 'Update failed: ' + responseText;
}
