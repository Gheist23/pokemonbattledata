// POST {"email":"..."} -> re-sends the key that address already owns.
//
// Always answers the same way whether or not the address has a licence: a
// difference in the reply would turn this into a "does this person subscribe?"
// oracle for anyone who cares to ask.

import { getRecordByEmail, json, normaliseEmail } from "./_lib.js";

const SAME_ANSWER = { ok: true, message: "If that address has a licence, the key is on its way." };
const COOLDOWN_SECONDS = 300;

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected JSON" }, 400);
  }
  const email = normaliseEmail(body.email);
  if (!email || !email.includes("@")) return json({ error: "Enter an email address." }, 400);

  // One send per address per cooldown, so this cannot be used to mail-bomb.
  const throttleKey = `resend:${email}`;
  if (await env.LICENSES.get(throttleKey)) return json(SAME_ANSWER);
  await env.LICENSES.put(throttleKey, "1", { expirationTtl: COOLDOWN_SECONDS });

  const record = await getRecordByEmail(env, email);
  if (!record || !env.RESEND_API_KEY) return json(SAME_ANSWER);

  const download = env.DOWNLOAD_URL || "https://championsbattledata.com/pro-tool/download/";
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.LICENSE_FROM_EMAIL || "Champions Battle Data <keys@championsbattledata.com>",
      to: [record.email],
      subject: "Your Companion Pro licence key",
      html: `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.55">
        <p>Here is your licence key again:</p>
        <p style="font-family:ui-monospace,Consolas,monospace;font-size:1.25rem;letter-spacing:.06em;
                  background:#0f1827;color:#e7f6ff;padding:.9rem 1rem;border-radius:10px">${record.key}</p>
        <p><a href="${download}">Download the Companion</a>, then Settings &rarr; Licence &rarr; Activate.</p>
      </div>`,
    }),
  });
  return json(SAME_ANSWER);
}
