# DevOps & Deployment Mode

## Trigger

Activate when the user asks about:
`deploy`, `deployment`, `CI`, `CD`, `pipeline`, `Docker`, `Dockerfile`, `docker-compose`,
`Kubernetes`, `k8s`, `Helm`, `terraform`, `infrastructure`, `nginx`, `reverse proxy`,
`certificate`, `SSL`, `TLS`, `environment variables`, `secrets management`, `monitoring`,
`Prometheus`, `Grafana`, `log aggregation`, `GitHub Actions`, `CircleCI`, `build`

## Procedure

### For deployment tasks:
1. Identify the target environment (dev/staging/prod)
2. Read the existing Dockerfile or docker-compose.yml
3. Check for environment-specific config (`.env.example`, `config/`)
4. Identify the build command and dependencies
5. Check for existing CI/CD configuration (`.github/workflows/`, `.circleci/`)
6. Make changes, verifying syntax (YAML, Dockerfile)
7. Provide the deploy command and what to watch for

### For infrastructure tasks:
1. Read existing IaC files (Terraform, Pulumi, Helm charts)
2. Understand the target provider (AWS, GCP, Azure, Vercel, Fly, Railway)
3. Make minimal changes
4. Validate syntax before suggesting apply/deploy

### For CI/CD pipeline tasks:
1. Read existing workflow files
2. Understand the test/build/deploy sequence
3. Add/modify jobs maintaining the existing structure
4. Ensure secrets are referenced from env vars, not hardcoded

## Output Format

For Docker changes, show the diff and the commands to test:
```
docker build -t app:local .
docker run --env-file .env -p 3000:3000 app:local
```

For deployment, show:
- The command to run
- How to verify success (health endpoint, logs)
- How to rollback if needed

## Constraints

```
CRITICAL RULES:
- Never hardcode secrets in config files — use environment variables
- Never modify production infrastructure without confirming the target
- Always show the rollback procedure for destructive changes
- Prefer declarative (IaC) over imperative changes
- Tag Docker images with version, not just 'latest'
- Always check if a migration is needed before deploying schema changes
```

## Common Patterns

### Dockerfile best practices:
- Multi-stage builds to minimize image size
- Non-root user for the runtime stage
- `.dockerignore` to exclude `node_modules`, `.env`, `.git`
- Pin base image versions (not `node:latest`)

### GitHub Actions:
- Cache dependencies (`actions/cache`)
- Run tests before deploy
- Use environment protection rules for production
- Store secrets in GitHub Secrets, reference as `${{ secrets.MY_SECRET }}`

### Health checks:
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
  interval: 30s
  timeout: 10s
  retries: 3
```
