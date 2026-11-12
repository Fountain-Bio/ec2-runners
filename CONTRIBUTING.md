# Contributing

Bug reports and pull requests are welcome. Read [docs/architecture.md](docs/architecture.md) before changing how runners launch or retire, and [AGENTS.md](AGENTS.md) for the conventions the code follows.

## Development

The code is TypeScript for the Node.js 24 Lambda runtime. The toolchain is [Vite+](https://viteplus.dev) (`vp`), configured in `vite.config.ts`, with [Bun](https://bun.com) as the package manager. GitHub calls and webhook payload types come from Octokit, whose retry and throttling plugins retry server errors and pace requests as GitHub recommends. Zod parses the environment, the app secret, and the rows read from the jobs table.

```bash
bun install
bun run check            # vp check: Oxfmt formatting, then Oxlint with type checking (Node types only)
bun run fmt              # vp fmt: formats the code in place
bun run test             # vp test: Vitest; plain `bun test` runs Bun's runner instead
bun run test:integration # jobs table against DynamoDB Local; needs Docker
bun run build            # vp pack: writes .build/lambda; deploy.sh runs this
bun run lint:template    # cfn-lint through uvx; needs uv
```

`deploy.sh` bundles `src/index.ts` and its dependencies, including the AWS SDK clients, into `.build/lambda` with `vp pack`. The bundle is `index.mjs` plus a few chunk files, and all three functions use the whole directory as their code.

`.github/workflows/ci.yml` runs these checks on every push to `main` and every pull request, on GitHub-hosted runners.

## Testing a change end to end

The unit tests stub AWS and GitHub, so a change to launch, boot, or MicroVM behaviour also needs a run against a real stack. Deploy your branch to a test account with its own `STACK` name and GitHub organization (see [docs/setup.md](docs/setup.md)), and run a workflow that exercises the change. Say in the pull request what you ran.

## Pull requests

- Keep each commit to one logical change, with tests passing, and write the commit message for someone reading `git log` later: what changed and why.
- Update the docs in the same pull request when behaviour, labels, parameters, or alerts change.
- A new environment variable goes in the handler's Zod schema in `src/config.ts` and in that function's `Environment` block in `template.yaml`.
