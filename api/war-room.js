import { getVercelOidcToken } from "@vercel/oidc";

const GATEWAY = "https://ai-gateway.vercel.sh/v1/chat/completions";

async function callModel({ token, model, system, user, maxTokens = 420 }) {
  const response = await fetch(GATEWAY, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.25,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(model + " failed: " + raw.slice(0, 500));
  const data = JSON.parse(raw);
  return {
    text: data.choices?.[0]?.message?.content?.trim() || "(No text returned)",
    usage: data.usage || {}
  };
}

export default async function handler(req, res) {
  const smoke = req.method === "GET" && String(req.query?.smoke || "") === "1";
  if (req.method !== "POST" && !smoke) return res.status(405).json({ error: "POST required" });

  const objective = smoke
    ? "Smoke test: identify one risk in a multi-agent AI dashboard in one short sentence."
    : String(req.body?.objective || "").trim().slice(0, 6000);

  if (!objective) return res.status(400).json({ error: "objective required" });

  try {
    const token = await Promise.resolve(getVercelOidcToken());
    if (!token) throw new Error("Vercel OIDC token is unavailable for AI Gateway.");

    const light1 = await callModel({
      token,
      model: "openai/gpt-5.6-sol",
      maxTokens: smoke ? 90 : 480,
      system: `You are Light, Project Light's exacting operating strategist.
Do not flatter the user's idea. Distinguish a small cash tactic from a scalable business.
For decisions, identify the attraction, strongest flaw, hidden assumption, ceiling, labor trap, automation implications, and the smallest evidence-producing next step.
Be concise, concrete, and willing to reject weak ideas.`,
      user: objective
    });

    const grok = await callModel({
      token,
      model: "spacexai/grok-4.5",
      maxTokens: smoke ? 90 : 480,
      system: `You are Grok in an independent red-team seat.
You are reviewing another agent's proposed analysis. Attack unsupported assumptions, weak economics, hidden operational labor, technical fantasy, and opportunity cost.
Do not agree merely to be cooperative. Identify what evidence would falsify the proposal and what should happen next.`,
      user: `OBJECTIVE:\n${objective}\n\nLIGHT'S FIRST PASS:\n${light1.text}`
    });

    const synthesis = await callModel({
      token,
      model: "openai/gpt-5.6-sol",
      maxTokens: smoke ? 90 : 420,
      system: `You are Light closing a multi-model decision round.
Use the other model's criticism rather than defending your first answer.
Return a decisive synthesis: what survives, what is rejected, and exactly one bounded next action.
If the task is build-related, create a short execution brief that a coding agent could act on.`,
      user: `OBJECTIVE:\n${objective}\n\nYOUR FIRST PASS:\n${light1.text}\n\nGROK RED TEAM:\n${grok.text}`
    });

    const usageRows = [light1.usage, grok.usage, synthesis.usage];
    const totalTokens = usageRows.reduce((n,u)=>n + (u.total_tokens || u.totalTokens || 0),0);

    return res.status(200).json({
      ok: true,
      smoke,
      turns: [
        { agent: "Light", model: "GPT-5.6 Sol", content: light1.text },
        { agent: "Grok", model: "Grok 4.5", content: grok.text },
        { agent: "Light — synthesis", model: "GPT-5.6 Sol", content: synthesis.text }
      ],
      codex: {
        status: "executor not connected",
        message: "This lane is intentionally not pretending to be Codex. The UI is ready; a real Codex executor must be attached before it can edit/run code.",
        task: "Take the final synthesis and implement the smallest testable code change in an isolated workspace, run validation, then report the diff and evidence."
      },
      usage: { modelCalls: 3, totalTokens }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}