// Vercel serverless function that triggers the GitHub Actions
// "refresh-snapshots" workflow on demand and reports status of the latest run.
//
// Required Vercel environment variables:
//   GH_DISPATCH_TOKEN  fine-grained PAT scoped to gokhanseckin/brix with
//                      "Actions: read & write" + "Contents: read" permissions
//   GH_OWNER           defaults to "gokhanseckin"
//   GH_REPO            defaults to "brix"
//   GH_WORKFLOW_FILE   defaults to "refresh.yml" (the YAML filename in
//                      .github/workflows; must end in .yml/.yaml)
//   GH_BRANCH          defaults to "main"

const DEFAULTS = {
  owner: "gokhanseckin",
  repo: "brix",
  workflowFile: "refresh-snapshots.yml",
  branch: "main",
};

function cfg() {
  return {
    token: process.env.GH_DISPATCH_TOKEN,
    owner: process.env.GH_OWNER || DEFAULTS.owner,
    repo: process.env.GH_REPO || DEFAULTS.repo,
    workflow: process.env.GH_WORKFLOW_FILE || DEFAULTS.workflowFile,
    branch: process.env.GH_BRANCH || DEFAULTS.branch,
  };
}

async function gh(path, { token, method = "GET", body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }
  return { ok: res.ok, status: res.status, body: json ?? text };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const c = cfg();
  if (!c.token) {
    return res.status(500).json({
      error:
        "GH_DISPATCH_TOKEN is not set on the server. Add a fine-grained PAT in Vercel project env vars.",
    });
  }

  if (req.method === "POST") {
    const dispatch = await gh(
      `/repos/${c.owner}/${c.repo}/actions/workflows/${c.workflow}/dispatches`,
      {
        token: c.token,
        method: "POST",
        body: { ref: c.branch },
      },
    );
    if (!dispatch.ok) {
      return res.status(dispatch.status || 502).json({
        error: "Failed to trigger workflow",
        detail: dispatch.body,
      });
    }
    // GitHub does not return the run id from /dispatches; the run takes a
    // moment to appear in the run list. The client polls GET to find it.
    return res.status(202).json({
      ok: true,
      dispatchedAt: new Date().toISOString(),
      branch: c.branch,
      workflow: c.workflow,
    });
  }

  if (req.method === "GET") {
    const list = await gh(
      `/repos/${c.owner}/${c.repo}/actions/workflows/${c.workflow}/runs?branch=${encodeURIComponent(c.branch)}&per_page=5`,
      { token: c.token },
    );
    if (!list.ok) {
      return res.status(list.status || 502).json({
        error: "Failed to list workflow runs",
        detail: list.body,
      });
    }
    const runs = (list.body?.workflow_runs || []).map((r) => ({
      id: r.id,
      status: r.status, // queued | in_progress | completed
      conclusion: r.conclusion, // success | failure | cancelled | null
      event: r.event,
      created_at: r.created_at,
      updated_at: r.updated_at,
      html_url: r.html_url,
      run_number: r.run_number,
    }));
    return res.status(200).json({ ok: true, runs });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
