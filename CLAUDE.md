# ec2-runners

Ephemeral GitHub Actions runners on EC2 Spot for the example-org org, deployed as one CloudFormation stack (`template.yaml`). `README.md` covers the architecture, labels, setup, and alerts; read it before changing behaviour.

## Deploying

- `AWS_PROFILE=dev ./deploy.sh` deploys to the development account in us-west-2. The stack runs only there; other accounts have no runner stack.
- Before committing, run `bun run check`, `bun run test`, `bun run lint:template`, and, when `src/jobs.ts` or `src/lock.ts` changes, `bun run test:integration` (needs Docker). CI runs the same checks on this stack's own runners, so a broken deploy also shows up as CI waiting for a runner.

## The runner pool

GitHub hands a queued job to any idle runner whose labels include all of the job's labels, whichever job the runner was launched for. The reconciler therefore treats runners as a **pool**: each pass matches queued jobs to available runners (`src/pool.ts`, maximum bipartite matching), launches only for jobs left without one, and retires spare runners whose own job no longer waits. Keep that model when changing launch logic: a runner's name records the job it was launched for, never the job it will run.

Reconcile passes never overlap. The lock is one item in the jobs table (`jobId` 0, `src/lock.ts`); an invocation that finds it held records a rerun request and exits.

## Code

- The toolchain is Vite+ (`vp`), configured in `vite.config.ts`, with Bun as the package manager. `vp pack` bundles `src/` for the Node.js 24 Lambda runtime, `vp test` runs the tests under Vitest (import test APIs from `vite-plus/test`), and `vp check` checks formatting (Oxfmt; `bun run fmt` fixes it), lints, and type-checks. `tsconfig.json` loads Node types only, so a Bun API fails the check. Run tests with `bun run test`: plain `bun test` starts Bun's own test runner.
- Each handler (`webhook.ts`, `reconciler.ts`, `janitor.ts`) parses its own environment with the matching Zod schema in `config.ts`. A new variable goes in the schema and in that function's `Environment` block in `template.yaml`.
- Job-label problems that can never launch throw `JobConfigError`; anything else counts as a retryable launch failure.
- `test/handlers.test.ts` stubs AWS clients through their prototypes' `send`, GitHub through `fetch`, and the jobs table with an in-memory fake that interprets the store's update expressions. The integration tests run the real expressions against DynamoDB Local, so a change to an expression in `jobs.ts` updates the fake and runs `test:integration`.

## Account-level resources outside the template

These were set up by hand in the development account, and the stack must not create them:

- The Amazon Q Developer (Chatbot) channel configuration `slack-alerts` for #alerts, which subscribes to the stack's alert topic (README, setup step 2). A Slack channel allows one configuration per account, so a stack-owned one fails to deploy.
- Quotas: Lambda concurrency 1,000, Spot 256 vCPUs, On-Demand 16 vCPUs. One monorepo CI run uses 44 Spot vCPUs.
