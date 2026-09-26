import { Sandbox } from "@vercel/sandbox";

const NAME = "project-light-agent";
const ROOT = "/vercel/sandbox/project-light-agent";
const SNAPSHOT_TTL = 30 * 24 * 60 * 60 * 1000;

async function readJson(sandbox, path) {
  const r = await sandbox.runCommand("cat", [path]);
  if (r.exitCode !== 0) throw new Error(await r.stderr());
  return JSON.parse(await r.stdout());
}

export default async function handler(req, res) {
  const action = String(req.query?.action || "status");

  let sandbox;

  try {
    sandbox = await Sandbox.getOrCreate({
      name: NAME,
      resume: true,
      snapshotExpiration: SNAPSHOT_TTL,
      onCreate: async (sbx) => {
        await sbx.runCommand("mkdir", [
          "-p",
          `${ROOT}/memory`,
          `${ROOT}/logs`,
          `${ROOT}/skills`
        ]);

        const state = {
          version: 1,
          cycle: 0,
          createdAt: new Date().toISOString(),
          objective:
            "Become progressively more useful while minimizing model calls, token usage, compute, repeated work, and unnecessary complexity.",
          totalModelCalls: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          lastResult: null
        };

        await sbx.writeFiles([
          {
            path: `${ROOT}/state.json`,
            content: Buffer.from(JSON.stringify(state, null, 2))
          },
          {
            path: `${ROOT}/memory/lessons.json`,
            content: Buffer.from("[]")
          },
          {
            path: `${ROOT}/identity.md`,
            content: Buffer.from(
`# Project Light Agent

You are a persistent AI agent operating inside a sandbox.

Goal: improve your ability to produce useful results over time while minimizing model calls, tokens, compute, repeated work, and unnecessary complexity.

Rules:
- Preserve useful knowledge between cycles.
- Record concrete lessons, not long conversations.
- Prefer deterministic code/tools over model calls when possible.
- Make one bounded improvement per cycle.
- Do not claim improvement without evidence.
- Keep memory compact.
`
            )
          }
        ]);
      }
    });

    if (action === "status") {
      const state = await readJson(sandbox, `${ROOT}/state.json`);
      const lessons = await readJson(sandbox, `${ROOT}/memory/lessons.json`);
      await sandbox.stop();

      return res.status(200).json({
        ok: true,
        sandbox: NAME,
        persistent: true,
        sleeping: true,
        state,
        recentLessons: lessons.slice(-3)
      });
    }

    if (action !== "run") {
      await sandbox.stop();
      return res.status(400).json({
        ok: false,
        error: "Use ?action=status or ?action=run"
      });
    }

    const oidc = process.env.VERCEL_OIDC_TOKEN;
    if (!oidc) throw new Error("VERCEL_OIDC_TOKEN unavailable");

    const objective = String(
      req.query?.objective ||
      "Run one low-cost evolution cycle and identify one useful improvement to your operating process."
    ).slice(0, 1000);

    const runner = `
const fs = require("fs");

const ROOT = ${JSON.stringify(ROOT)};
const objective = ${JSON.stringify(objective)};

async function main() {
  const statePath = ROOT + "/state.json";
  const lessonsPath = ROOT + "/memory/lessons.json";

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const lessons = JSON.parse(fs.readFileSync(lessonsPath, "utf8"));
  const recentLessons = lessons.slice(-3);

  const prompt = [
    "You are Project Light Agent running inside a persistent sandbox.",
    "Your job is to improve your own operating process conservatively and cheaply.",
    "",
    "Current objective:",
    objective,
    "",
    "Cycle:",
    String(state.cycle + 1),
    "",
    "Recent lessons:",
    JSON.stringify(recentLessons),
    "",
    "Return ONLY valid compact JSON:",
    '{"assessment":"...","lesson":"...","nextObjective":"..."}',
    "",
    "Rules:",
    "- One bounded improvement only.",
    "- Do not invent evidence.",
    "- Keep the lesson reusable and concise.",
    "- Prefer deterministic tools over future model calls."
  ].join("\n");

  const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.VERCEL_OIDC_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "google/gemini-3.5-flash-lite",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 220
    })
  });

  if (!response.ok) {
    throw new Error("AI Gateway " + response.status + ": " + await response.text());
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || "";

  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    result = {
      assessment: raw.slice(0, 500),
      lesson: "Model output was not valid JSON; enforce structured output more strictly.",
      nextObjective: "Improve structured-response reliability."
    };
  }

  state.cycle += 1;
  state.totalModelCalls += 1;
  state.totalInputTokens += data.usage?.prompt_tokens || 0;
  state.totalOutputTokens += data.usage?.completion_tokens || 0;
  state.lastResult = {
    timestamp: new Date().toISOString(),
    objective,
    ...result
  };

  lessons.push({
    cycle: state.cycle,
    timestamp: new Date().toISOString(),
    lesson: result.lesson
  });

  while (lessons.length > 100) lessons.shift();

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  fs.writeFileSync(lessonsPath, JSON.stringify(lessons, null, 2));

  console.log(JSON.stringify({
    ok: true,
    cycle: state.cycle,
    model: "google/gemini-3.5-flash-lite",
    result,
    usage: data.usage || null,
    totalModelCalls: state.totalModelCalls
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

    const command = await sandbox.runCommand({
      cmd: "node",
      args: ["-e", runner],
      env: { VERCEL_OIDC_TOKEN: oidc }
    });

    const stdout = (await command.stdout()).trim();
    const stderr = (await command.stderr()).trim();

    await sandbox.stop();

    if (command.exitCode !== 0) {
      return res.status(500).json({
        ok: false,
        exitCode: command.exitCode,
        error: stderr
      });
    }

    return res.status(200).json({
      ok: true,
      sandbox: NAME,
      persistent: true,
      sleeping: true,
      cycleResult: JSON.parse(stdout)
    });
  } catch (error) {
    if (sandbox) await sandbox.stop().catch(() => {});
    console.error(error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
