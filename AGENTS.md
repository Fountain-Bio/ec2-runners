# ec2-runners

Ephemeral GitHub Actions runners on EC2 Spot and AWS Lambda MicroVMs for one GitHub organization, deployed as one CloudFormation stack (`template.yaml`). Read `docs/architecture.md` before changing launch or retire behaviour; `docs/` also covers setup, usage, and operations.

To deploy the stack or connect it to an organization, follow `.agents/skills/setup-ec2-runners`. To find out why a job is still queued or an alert fired, follow `.agents/skills/debug-ec2-runners`. To move a repository's workflows onto the runners, follow `.agents/skills/adopt-ec2-runners`.

## Checks

Before committing, run `bun run check`, `bun run test`, and `bun run lint:template`. When `src/jobs.ts` or `src/lock.ts` changes, also run `bun run test:integration` (needs Docker). CI runs the same checks on GitHub-hosted runners.

## The runner pool

GitHub hands a queued job to any idle runner whose labels include all of the job's labels, whichever job the runner was launched for. The reconciler therefore treats runners as a **pool**: each pass matches queued jobs to available runners (`src/pool.ts`, maximum bipartite matching), launches only for jobs left without one, and retires spare runners whose own job no longer waits. Keep that model when changing launch logic: a runner's name records the job it was launched for, never the job it will run. MicroVM runners (`src/microvm.ts`) are in the same pool: their registrations carry a `microvm-id=<id>` label that stands in for EC2's instance tags.

Reconcile passes never overlap. The lock is one item in the jobs table (`jobId` 0, `src/lock.ts`); an invocation that finds it held records a rerun request and exits.

## Code

- The toolchain is Vite+ (`vp`), configured in `vite.config.ts`, with Bun as the package manager. `vp pack` bundles `src/` for the Node.js 24 Lambda runtime, `vp test` runs the tests under Vitest (import test APIs from `vite-plus/test`), and `vp check` checks formatting (Oxfmt; `bun run fmt` fixes it), lints, and type-checks. `tsconfig.json` loads Node types only, so a Bun API fails the check. Run tests with `bun run test`: plain `bun test` starts Bun's own test runner.
- Each handler (`webhook.ts`, `reconciler.ts`, `janitor.ts`) parses its own environment with the matching Zod schema in `config.ts`. A new variable goes in the schema and in that function's `Environment` block in `template.yaml`.
- Job-label problems that can never launch throw `JobConfigError`; anything else counts as a retryable launch failure.
- `test/handlers.test.ts` stubs AWS clients through their prototypes' `send`, GitHub through `fetch`, and the jobs table with an in-memory fake that interprets the store's update expressions. The integration tests run the real expressions against DynamoDB Local, so a change to an expression in `jobs.ts` updates the fake and runs `test:integration`.
- Behaviour, labels, parameters, and alerts are documented in `docs/`. A change to any of them updates the matching page in the same commit.
- `.agents/skills/` ships three ways: to agents in a clone, to Claude Code through the `.claude/skills` links, and as the `ec2-runners` plugin listed in `.claude-plugin/marketplace.json`, whose root is the repository root. A skill refers to repository files by their path from the repository root, three directories above the skill's folder, and runs `claude plugin validate .` after a change.

## Resources outside the template

The stack must not create account-level resources that an account can hold only one of. The Amazon Q Developer (Chatbot) channel configuration that forwards alerts to chat is one: a chat channel allows one configuration per account, so a stack-owned one fails to deploy wherever the account already has one. Deployments subscribe their existing configuration to the stack's alert topic (`docs/setup.md`, step 5).

Deployment-specific notes, such as which AWS profile and account a team deploys to, belong in a gitignored `CLAUDE.local.md` or similar local file.
