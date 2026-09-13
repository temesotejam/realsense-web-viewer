const INTEL_T265_FIRMWARE_URL =
  "https://librealsense.intel.com/Releases/TM2/FW/target/0.2.0.951/target-0.2.0.951.mvcmd";

const ROUTE = "/t265/0.2.0.951.mvcmd";
const ALLOWED_ORIGIN = "https://temesotejam.github.io";
const EXPECTED_SIZE = "9323648";
const EXPECTED_SHA256 =
  "0265fd111611908b822cdaf4a3fe5b631c50539b2805d2f364c498aa71c007c0";

function corsHeaders(origin) {
  const headers = new Headers();
  if (origin === ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    headers.set(
      "Access-Control-Expose-Headers",
      "Content-Length, X-T265-Firmware-Source, X-T265-Firmware-SHA256"
    );
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

function plain(status, text, origin = null) {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(text, { status, headers });
}

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (requestUrl.pathname !== ROUTE) {
      return plain(404, "Not found.\n", origin);
    }

    if (origin && origin !== ALLOWED_ORIGIN) {
      return plain(403, "Origin not allowed.\n");
    }

    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) {
        return plain(403, "Origin not allowed.\n");
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "Method not allowed.\n", origin);
    }

    let upstream;
    try {
      upstream = await fetch(INTEL_T265_FIRMWARE_URL, {
        method: request.method,
        redirect: "follow",
        cache: "no-store",
        headers: {
          Accept: "application/octet-stream,*/*;q=0.8",
        },
      });
    } catch (error) {
      return plain(
        502,
        `Intel firmware fetch failed: ${error?.message || error}\n`,
        origin
      );
    }

    if (!upstream.ok) {
      return plain(
        502,
        `Intel firmware source returned HTTP ${upstream.status}.\n`,
        origin
      );
    }

    const headers = corsHeaders(origin);
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Cache-Control", "no-store, max-age=0");
    headers.set("Pragma", "no-cache");
    headers.set("X-T265-Firmware-Source", "Intel RealSense official CDN");
    headers.set("X-T265-Firmware-SHA256", EXPECTED_SHA256);

    const upstreamLength = upstream.headers.get("Content-Length");
    if (upstreamLength) headers.set("Content-Length", upstreamLength);
    else headers.set("X-T265-Firmware-Expected-Length", EXPECTED_SIZE);

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: 200,
      headers,
    });
  },
};
