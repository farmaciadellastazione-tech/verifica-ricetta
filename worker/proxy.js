// Cloudflare Worker — proxy verso Google Gemini API
//
// Architettura:
//   browser (GH Pages) --POST--> Cloudflare Worker --POST + key--> Gemini API
//
// La chiave GEMINI_API_KEY e' configurata come secret nel dashboard Cloudflare
// (Worker -> Settings -> Variables and Secrets -> tipo "Secret"). NON viene mai
// esposta al browser. Solo richieste provenienti dall'origin GH Pages della
// farmacia vengono inoltrate, le altre ricevono 403.
//
// Deploy:
//   1. https://dash.cloudflare.com -> Workers & Pages -> Create Worker
//   2. Incolla questo file come codice del worker
//   3. Settings -> Variables and Secrets -> Add: GEMINI_API_KEY (Secret) = AIza...
//   4. Save and deploy
//   5. Copia l'URL del worker (es. verifica-ricetta-proxy.tuonome.workers.dev)
//      e configurala come PROXY_URL nell'app

const ALLOWED_ORIGIN = 'https://farmaciadellastazione-tech.github.io';
const MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return jsonError(405, 'Method not allowed');
    }

    // Blocca richieste browser-based da altre origini
    if (origin !== ALLOWED_ORIGIN) {
      return jsonError(403, 'Origin non autorizzata', { origin });
    }

    if (!env.GEMINI_API_KEY) {
      return jsonError(500, 'GEMINI_API_KEY non configurata sul Worker');
    }

    const body = await request.text();
    const geminiUrl = `${GEMINI_ENDPOINT}?key=${env.GEMINI_API_KEY}`;

    let upstream;
    try {
      upstream = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      return jsonError(502, 'Upstream fetch failed', { detail: err.message });
    }

    const respBody = await upstream.text();
    return new Response(respBody, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};

function jsonError(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: { message, ...extra } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
