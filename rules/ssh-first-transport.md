# SSH-First Git Transport

Git transport is SSH. HTTPS-with-a-token is not a fallback to reach for when SSH misbehaves — it
is an escalation the operator approves, after SSH has actually been exhausted. This rule exists
because a token push happened before a one-minute diagnosis that would have made it unnecessary.

## 1. Read the failure before changing anything

The error names the problem, and the two problems have disjoint fixes:

- **`Permission denied (publickey)`** — an auth problem. The transport is fine.
- **Timeout or connection refused** — a network problem. The key is fine.

Switching transport answers neither. Diagnose first; the whole tree below takes under a minute.

## 2. Auth problems: it is about keys

```sh
ssh -o IdentitiesOnly=yes -i <keyfile> -T git@<host>   # which identity is really offered?
ssh-keygen -lf <keyfile>.pub                            # fingerprint, to compare with the forge
```

Verify the key is registered with the forge account the remote expects. If it is missing, adding
it is an operator decision — say what you found and which key you propose to add.

## 3. Network problems: another port before another protocol

```sh
nc -z -G 6 <host> 22          # is it this host, or this port anywhere?
```

Both major providers publish SSH on 443 for firewalled networks — same protocol, same keys,
different port. This is a designed endpoint, not a workaround:

| Provider | Endpoint |
| --- | --- |
| GitHub | `ssh.github.com:443` |
| gitlab.com | `altssh.gitlab.com:443` |
| self-hosted GitLab | ask the operator; many publish an alt-ssh port |

Compare against a host that works (`nc -z <corporate-gitlab> 22`): if internal :22 is open while
the provider's is not, it is the VPN's egress policy, and port 443 is the answer.

## 4. Fix the configuration, not the one command

A working discovery becomes a permanent `~/.ssh/config` entry with a comment saying why, so the
next session inherits the fix instead of the failure:

```
Host github-<alias>
    # VPN drops egress to github.com:22; ssh.github.com:443 is GitHub's
    # official SSH endpoint for firewalled networks — same protocol, same key.
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile ~/.ssh/<key>
    IdentitiesOnly yes
```

Back up the config before editing it. Verify with `ssh -T git@<alias>` and `git ls-remote`, and
repoint any branch upstreams that were set against a temporary URL.

## 5. HTTPS is operator-gated

Only when SSH is genuinely unavailable on every port: **stop and ask** before any
token-over-HTTPS git operation. Never quietly stack `credential.helper` overrides to make a push
go through — the credential store answering with the wrong account's token is exactly how that
path fails, and it fails as a push under the wrong identity.

## 6. What this rule does not cover

Forge API CLIs (`gh`, `glab`) speak HTTPS to the REST/GraphQL API. That is not git transport;
issues, MRs and API reads are unaffected by this rule.
