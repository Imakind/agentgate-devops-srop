from copy import deepcopy
from xml.etree import ElementTree as ET

import pytest

from agentgate.app import examples
from agentgate.core import MAX_BYTES, ValidationError, canonical_domain, evaluate, load_json, to_junit


def codes(report):
    return {v["code"] for v in report["violations"]}


def test_compliant_trace_is_repeatable_and_does_not_mutate(trace, policy):
    before = deepcopy((trace, policy))
    first = evaluate(trace, policy)
    assert first == evaluate(trace, policy)
    assert (trace, policy) == before
    assert first["status"] == "passed"
    assert first["summary"] == dict(total_steps=5, passed_steps=5, failed_steps=0, total_tokens=3050, tool_calls=5, violations=0)
    assert all(check["passed"] for check in first["checks"])


def test_boundary_fixture_has_three_different_checks():
    report = evaluate(examples()[1]["trace"])
    assert codes(report) == {"tools", "domains", "approvals"}
    assert report["summary"]["failed_steps"] == 3


def test_budget_fixture_reports_cumulative_limits():
    report = evaluate(examples()[2]["trace"])
    assert report["summary"]["total_tokens"] == 5850
    assert codes(report) == {"token_budget", "call_budget"}
    assert report["steps"][6]["status"] == "passed"
    assert report["steps"][7]["status"] == "failed"
    assert len(report["steps"][8]["violations"]) == 2


def test_equal_budget_is_allowed(trace, policy):
    policy.update(max_tokens=3050, max_tool_calls=5)
    assert evaluate(trace, policy)["status"] == "passed"
    policy["max_tokens"] = 3049
    assert codes(evaluate(trace, policy)) == {"token_budget"}


def test_zero_budgets_fail_nonzero_usage(trace, policy):
    policy.update(max_tokens=0, max_tool_calls=0)
    report = evaluate(trace, policy)
    assert report["summary"]["failed_steps"] == 5
    assert codes(report) == {"token_budget", "call_budget"}


@pytest.mark.parametrize("url", [
    "https://docs.python.org.attacker.example/", "https://sub.docs.python.org/",
    "https://docs.python.org@attacker.example/", "javascript:alert(1)",
    "file:///etc/passwd", "https://docs.python.org:99999/", "https://docs.python.org\\@attacker.example/",
    "https://docs.python.org/%0A\n", "https://docs.python.org%2Eattacker.example/",
])
def test_url_boundaries_are_not_allowlist_bypasses(trace, url):
    trace["steps"][1]["url"] = url
    assert "domains" in codes(evaluate(trace))


def test_domain_case_and_trailing_dot_are_canonical(trace):
    trace["steps"][1]["url"] = "https://DOCS.PYTHON.ORG./3/"
    assert evaluate(trace)["status"] == "passed"
    assert canonical_domain("BÜCHER.example.") == "xn--bcher-kva.example"


def test_web_open_without_url_is_a_policy_failure(trace):
    del trace["steps"][1]["url"]
    assert "domains" in codes(evaluate(trace))


@pytest.mark.parametrize("mutation", ["missing", "denied", "wrong_tool", "wrong_step", "unknown_id"])
def test_approval_must_bind_the_specific_step_and_tool(trace, mutation):
    if mutation == "missing":
        trace["approvals"] = []
    elif mutation == "denied":
        trace["approvals"][0]["decision"] = "denied"
    elif mutation == "wrong_tool":
        trace["approvals"][0]["tool"] = "notes.write"
    elif mutation == "wrong_step":
        trace["approvals"][0]["step_id"] = "s4"
    else:
        trace["steps"][-1]["approval_id"] = "unknown"
    assert "approvals" in codes(evaluate(trace))


def test_policy_edit_recalculates_all_steps(trace, policy):
    policy["allowed_tools"].remove("notes.write")
    report = evaluate(trace, policy)
    assert report["steps"][3]["status"] == "failed"
    policy["allowed_tools"].append("notes.write")
    assert evaluate(trace, policy)["status"] == "passed"


@pytest.mark.parametrize("bad", [True, -1, 2.5, "100", None, 1_000_001])
def test_token_schema_rejects_non_integer_or_out_of_bounds(trace, bad):
    trace["steps"][0]["tokens"] = bad
    with pytest.raises(ValidationError):
        evaluate(trace)


def test_empty_and_excessively_long_trace_rejected(trace):
    for steps in ([], [trace["steps"][0]] * 101):
        with pytest.raises(ValidationError):
            evaluate({**trace, "steps": steps})


def test_duplicate_step_and_approval_ids_rejected(trace):
    original = deepcopy(trace)
    trace["steps"][1]["id"] = "s1"
    with pytest.raises(ValidationError):
        evaluate(trace)
    original["approvals"] *= 2
    with pytest.raises(ValidationError):
        evaluate(original)


def test_unknown_fields_fail_closed(trace):
    trace["steps"][0]["toknes"] = 1200
    with pytest.raises(ValidationError, match="неизвестные"):
        evaluate(trace)


@pytest.mark.parametrize("domain", ["*.python.org", "https://docs.python.org", "docs.python.org:443", " docs.python.org", "docs..python.org", "-bad.example"])
def test_invalid_allowlist_rejected(policy, trace, domain):
    policy["allowed_domains"] = [domain]
    with pytest.raises(ValidationError):
        evaluate(trace, policy)


def test_duplicate_canonical_domains_rejected(policy, trace):
    policy["allowed_domains"] = ["docs.python.org", "DOCS.PYTHON.ORG."]
    with pytest.raises(ValidationError):
        evaluate(trace, policy)


@pytest.mark.parametrize("raw", ['{"a":1,"a":2}', '{"n": NaN}', '{"n": Infinity}', '{', b'\xff', '[' * 2000],
                         ids=["duplicate-key", "nan", "infinity", "truncated", "invalid-utf8", "deeply-nested"])
def test_malformed_json_rejected(raw):
    with pytest.raises(ValidationError):
        load_json(raw)


def test_oversized_document_rejected():
    with pytest.raises(ValidationError, match="512"):
        load_json(b" " * (MAX_BYTES + 1))


def test_junit_escapes_user_content(trace):
    trace["name"] = 'Trace <script> & "quoted"'
    trace["steps"][0]["tool"] = "<unknown&tool>"
    root = ET.fromstring(to_junit(evaluate(trace)))
    assert root.attrib["tests"] == "5"
    assert root.attrib["failures"] == "1"
    assert root.attrib["name"] == "AgentGate: " + trace["name"]
    assert "<unknown&tool>" in root.find("testcase/failure").text


@pytest.mark.parametrize("bad", ["\x00", "\ud800", "\uffff"])
def test_xml_unsafe_input_rejected(trace, bad):
    trace["name"] += bad
    with pytest.raises(ValidationError):
        evaluate(trace)


def test_input_object_type_rejected():
    with pytest.raises(ValidationError):
        evaluate([])
