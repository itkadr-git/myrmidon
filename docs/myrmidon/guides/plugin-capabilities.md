# Plugin runtime capabilities

Plugins in Myrmidon run as isolated processes and interact with the control plane through a credential-isolated host bridge. Access to control plane operations is strictly capability-gated: plugins must statically declare required capabilities in their manifest, and the host enforces these capabilities before executing any worker operation.

## Capabilities overview

Capabilities are static and mandatory. Every plugin declares them in `manifest.capabilities`. The host validates incoming RPC requests and denies any operation not covered by granted capabilities (`CapabilityDeniedError`).

### Core capability groups

- **Issues**: `issues.read`, `issues.create`, `issues.update`, `issues.checkout`, `issues.wakeup`
- **Issue discussions**: `issue.comments.read`, `issue.comments.create`, `issue.comments.create_human_attributed`, `issue.interactions.create`, `issue.interactions.read`, `issue.interactions.respond`
- **Issue attachments**: `issue.attachments.read`, `issue.attachments.write`
- **Issue documents & relations**: `issue.documents.read`, `issue.documents.write`, `issue.relations.read`, `issue.relations.write`, `issue.subtree.read`
- **Agents & sessions**: `agents.read`, `agents.managed`, `agents.pause`, `agents.resume`, `agents.invoke`, `agent.sessions.create`, `agent.sessions.list`, `agent.sessions.send`, `agent.sessions.close`
- **System & state**: `activity.read`, `activity.log.write`, `plugin.state.read`, `plugin.state.write`, `database.namespace.read`, `database.namespace.write`, `secrets.read-ref`

---

## Issue attachments capabilities

Plugins frequently orchestrate tasks that produce deliverables, diagnostic artifacts, or logs. Two runtime capabilities govern attachment operations:

| Capability | Scope | Host methods | Description |
|---|---|---|---|
| `issue.attachments.read` | Read | `issues.listAttachments`, `issues.getAttachmentContent` | Lists attachment metadata and downloads bounded attachment byte content. |
| `issue.attachments.write` | Write | `issues.uploadAttachment` | Uploads bounded files to an issue through the credential-isolated host bridge. |

### `issue.attachments.write`

#### Purpose
Allows headless plugin workers to upload bounded file attachments (such as logs, test evidence, output dumps, or preview files) directly to an issue without requiring administrative board credentials, bearer tokens, or direct database access.

Typical workflow:
1. An orchestration plugin creates an issue via `ctx.issues.create`.
2. The plugin attaches evidence or report files via `ctx.issues.uploadAttachment`.
3. The attachment is registered with the issue, stored in instance storage, and logged in the audit trail.

#### Risks and guardrails

| Risk | Impact | Guardrail / Mitigation |
|---|---|---|
| **Storage exhaustion** | Excessive disk or object store usage | Hard ceiling of 10 MiB (`MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024`). Over-limit payloads are rejected immediately. |
| **Executable / dangerous files** | Security risk from malicious payloads | Strict MIME allowlist: `application/pdf`, `application/json`, `text/plain`, `text/markdown`, `text/csv`, `image/png`, `image/jpeg`. Binary executables and scripts are rejected. |
| **Corrupted / invalid data** | Data integrity issues | Payload must be valid canonical base64. Re-encoding checks ensure no corrupted data is accepted. |
| **Cross-company data leakage** | Plugin accessing or modifying issues of another company | Mandatory company boundary check: the target issue must belong to the caller's authorized company scope (`companyId`). Cross-company requests are rejected. |
| **Attribution spoofing** | Unaudited or forged file uploads | Every upload writes an audit entry in `activityLog` (`action: "issue.attachment.uploaded"`) recording the plugin, attachment ID, byte size, content type, and acting agent/user. |

#### Enabling and operator approval

1. **Manifest declaration**: The plugin developer includes `"issue.attachments.write"` in `manifest.capabilities` in `manifest.ts`:
   ```ts
   capabilities: [
     "issues.read",
     "issues.create",
     "issue.attachments.write",
   ],
   ```
2. **Operator review and approval**:
   - When a plugin is installed or upgraded, Myrmidon presents the operator with the list of requested capabilities.
   - Adding `issue.attachments.write` marks the plugin as `upgrade_pending` until the operator explicitly approves the capability change.
   - Without operator approval, any invocation of `uploadAttachment` fails with `CapabilityDeniedError`.

#### SDK usage example

```ts
// Inside a plugin worker or action handler:
const issue = await ctx.issues.create({
  companyId,
  projectId,
  title: "Automated scan results",
  status: "todo",
  priority: "medium",
});

const attachment = await ctx.issues.uploadAttachment({
  issueId: issue.id,
  companyId,
  filename: "scan-summary.json",
  contentType: "application/json",
  contentBase64: Buffer.from(JSON.stringify({ status: "passed", findings: 0 })).toString("base64"),
  actor: {
    actorAgentId: agentId,
  },
});

console.log(`Uploaded attachment ${attachment.id} (${attachment.byteSize} bytes)`);
```
