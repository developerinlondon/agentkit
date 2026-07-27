#!/usr/bin/env bash
# Supervises a policy hook inside the host timeout. Claude command-hook
# cancellation is non-blocking, so the child must time out first and emit deny.
set -u

deny_supervisor() {
	printf '%s\n' '{"decision":"deny","reason":"BLOCKED: fail-closed hook supervisor could not complete policy evaluation.","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: fail-closed hook supervisor could not complete policy evaluation."}}'
	exit 0
}

[[ $# -ge 2 ]] || deny_supervisor
case "$1" in
'' | *[!0-9]*) deny_supervisor ;;
esac
[[ "$1" -gt 0 ]] || deny_supervisor
command -v python3 >/dev/null 2>&1 || deny_supervisor

exec python3 -c '
import json, os, signal, subprocess, sys

REASON = "BLOCKED: fail-closed hook supervisor could not complete policy evaluation."

def deny():
    body = {
        "decision": "deny",
        "reason": REASON,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": REASON,
        },
    }
    sys.stdout.write(json.dumps(body, separators=(",", ":")) + "\n")
    raise SystemExit(0)

deadline = int(sys.argv[1])
command = sys.argv[2:]
payload = sys.stdin.buffer.read()

try:
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
except Exception:
    deny()

def terminate_process():
    # communicate() waits for EOF on every inherited pipe, not merely for the
    # direct child. A descendant can start a new session, survive killpg(), and
    # keep stdout open beyond the Claude host deadline. Close our pipe endpoints
    # and bound both TERM and KILL waits; a timeout must always reach deny().
    for stream in (process.stdin, process.stdout):
        try:
            if stream is not None:
                stream.close()
        except Exception:
            pass
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
        except Exception:
            pass
        try:
            process.wait(timeout=1)
            return
        except subprocess.TimeoutExpired:
            continue
        except Exception:
            return

try:
    output, _ = process.communicate(payload, timeout=deadline)
except subprocess.TimeoutExpired:
    terminate_process()
    deny()
except Exception:
    terminate_process()
    deny()

if process.returncode != 0:
    deny()
if not output.strip():
    raise SystemExit(0)

try:
    parsed = json.loads(output.decode("utf-8"))
except Exception:
    deny()
if not isinstance(parsed, dict):
    deny()

specific = parsed.get("hookSpecificOutput")
specific_deny = isinstance(specific, dict) and specific.get("permissionDecision") == "deny"
if parsed.get("decision") != "deny" and not specific_deny:
    deny()

sys.stdout.buffer.write(output)
' "$@"
