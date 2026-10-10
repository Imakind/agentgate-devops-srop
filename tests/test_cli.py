import json
import subprocess
import sys
import pytest
from xml.etree import ElementTree as ET

from agentgate.cli import main


def save(tmp_path, value):
    path = tmp_path / "trace.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    return str(path)


def test_cli_pass_stdout(tmp_path, trace, capsys):
    assert main(["check", save(tmp_path, trace)]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "passed"


def test_cli_policy_violation_exit_one(tmp_path, trace, capsys):
    trace["steps"][0]["tool"] = "blocked"
    assert main(["check", save(tmp_path, trace)]) == 1
    assert json.loads(capsys.readouterr().out)["status"] == "failed"


def test_cli_file_export(tmp_path, trace):
    output = tmp_path / "result.xml"
    assert main(["check", save(tmp_path, trace), "--format", "junit", "--output", str(output)]) == 0
    assert ET.parse(output).getroot().attrib["tests"] == "5"


def test_cli_invalid_input_and_missing_file(tmp_path, capsys):
    assert main(["check", save(tmp_path, [])]) == 2
    assert "AgentGate:" in capsys.readouterr().err
    assert main(["check", str(tmp_path / "absent.json")]) == 2


def test_cli_custom_policy(tmp_path, trace, policy, capsys):
    trace_path = save(tmp_path, trace)
    policy["max_tool_calls"] = 0
    policy_path = tmp_path / "policy.json"
    policy_path.write_text(json.dumps(policy), encoding="utf-8")
    assert main(["check", trace_path, "--policy", str(policy_path)]) == 1
    assert json.loads(capsys.readouterr().out)["summary"]["failed_steps"] == 5


def test_module_entrypoint_in_subprocess(tmp_path, trace):
    process = subprocess.run([sys.executable, "-m", "agentgate", "check", save(tmp_path, trace)], capture_output=True, text=True)
    assert process.returncode == 0
    assert json.loads(process.stdout)["status"] == "passed"


def test_explicit_null_policy_is_rejected(tmp_path, trace, capsys):
    trace_path = save(tmp_path, trace)
    policy_path = tmp_path / "policy.json"
    policy_path.write_text("null", encoding="utf-8")
    assert main(["check", trace_path, "--policy", str(policy_path)]) == 2
    assert "policy:" in capsys.readouterr().err


@pytest.mark.parametrize("port", ["-1", "0", "65536", "not-a-number"])
def test_serve_rejects_invalid_port_before_starting(port):
    with pytest.raises(SystemExit) as caught:
        main(["serve", "--port", port])
    assert caught.value.code == 2



def test_bundled_example_envelope_is_supported(tmp_path, capsys):
    from agentgate.app import examples
    assert main(["check", save(tmp_path, examples()[0])]) == 0
    assert json.loads(capsys.readouterr().out)["summary"]["total_steps"] == 5
