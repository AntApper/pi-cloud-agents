# First-Time-User Experience Test Script (T4.15)

Target: A user with an AWS account and pi gets a working cloud agent in **<= 15 minutes** from the README.

## 1. Prerequisites Checklist
- [ ] Node.js >= 22.19 installed (`node -v`)
- [ ] AWS credentials configured in `~/.aws/credentials` or `AWS_PROFILE` / `AWS_ACCESS_KEY_ID`
- [ ] Pinned pi installed (`pi --version`)

## 2. CLI First-Run Test
1. Run setup:
   ```bash
   npx pi-cloud-agents setup --verify
   ```
2. Observe Quick Setup summary screen:
   - Detected profile and target region (`us-east-1`)
   - Local providers found
   - Estimated monthly idle cost ($0.00)
3. Accept Quick Setup defaults:
   - Core CloudFormation stack deployed (~1 min)
   - Artifacts uploaded (~10s)
   - Image stack deployed (~2-3 min)
   - Verification checks run (~1-2 min)
4. Overall setup time must be **<= 15 minutes**.

## 3. TUI First-Run Test
1. Start pi in any git repo:
   ```bash
   pi
   ```
2. Run `/cloud`:
   - Pre-setup: Displays welcoming first-run overview.
   - Post-setup: Displays hub with fleet status and quick actions.
3. Launch a new cloud agent:
   ```bash
   /cloud new "Add unit test for helper function"
   ```
4. Attach to live mirror session:
   ```bash
   /cloud attach
   ```
5. Observe live streamed events, remote tool executions, and footer telemetry.
6. Detach cleanly:
   ```bash
   /cloud detach
   ```
