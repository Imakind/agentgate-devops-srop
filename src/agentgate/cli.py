"""Command-line interface: 0=pass, 1=policy failure, 2=input/usage error."""

import argparse
import json
from pathlib import Path
import sys

from agentgate.core import MAX_BYTES, ValidationError, evaluate, load_json, to_junit


def _read(path):
    with Path(path).open("rb") as stream:
        return load_json(stream.read(MAX_BYTES + 1))


def _port(value):
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("port must be an integer from 1 to 65535") from exc
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be from 1 to 65535 (0 is not supported)")
    return port


def main(argv=None):
    parser = argparse.ArgumentParser(prog="agentgate", description="Evaluate supplied AI-agent traces against a deterministic policy.")
    sub = parser.add_subparsers(dest="command", required=True)
    server = sub.add_parser("serve", help="Start the local dashboard (no authentication; local use only)")
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--port", type=_port, default=5050)
    check = sub.add_parser("check", help="Evaluate a JSON trace; exit nonzero on violation")
    check.add_argument("trace", help="Path to trace JSON (or bundled example envelope)")
    check.add_argument("--policy", help="Path to policy JSON")
    check.add_argument("--format", choices=("json", "junit"), default="json")
    check.add_argument("--output", help="Write report to this file instead of stdout")
    args = parser.parse_args(argv)
    if args.command == "serve":
        from agentgate.app import create_app
        create_app().run(host=args.host, port=args.port, debug=False)
        return 0
    try:
        trace = _read(args.trace)
        # The example envelope includes educational labels alongside the trace.
        if isinstance(trace, dict) and set(trace) == {"id", "name", "description", "trace"}:
            trace = trace["trace"]
        policy = _read(args.policy) if args.policy else None
        if args.policy and policy is None:
            raise ValidationError("policy: ожидается JSON-объект")
        report = evaluate(trace, policy)
        output = to_junit(report) if args.format == "junit" else json.dumps(report, ensure_ascii=False, indent=2)
        if args.output:
            Path(args.output).write_text(output + "\n", encoding="utf-8")
        else:
            print(output)
        return 0 if report["status"] == "passed" else 1
    except (ValidationError, OSError) as exc:
        print(f"AgentGate: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
