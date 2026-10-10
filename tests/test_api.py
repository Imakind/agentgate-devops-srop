from xml.etree import ElementTree as ET
from agentgate.core import MAX_BYTES


def test_packaged_dashboard_and_assets(client):
    page = client.get("/")
    assert page.status_code == 200
    assert b"AgentGate" in page.data
    for asset in ("app.js", "styles.css"):
        assert client.get("/static/" + asset).status_code == 200


def test_health_policy_and_examples(client):
    assert client.get("/api/health").json["status"] == "ok"
    assert client.get("/api/policy").json["policy"]["max_tokens"] == 5000
    examples = client.get("/api/examples").json["examples"]
    assert len(examples) == 3
    assert all("Учебный сценарий" in example["description"] for example in examples)


def test_api_evaluation_and_security_headers(client, trace):
    response = client.post("/api/evaluate", json={"trace": trace})
    assert response.status_code == 200
    assert response.json["status"] == "passed"
    assert "не аутентифицируются независимо" in response.json["disclaimer"]
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Cache-Control"] == "no-store"


def test_policy_failure_is_valid_report_not_server_error(client, trace):
    trace["steps"][0]["tool"] = "shell.exec"
    response = client.post("/api/evaluate", json={"trace": trace})
    assert response.status_code == 200
    assert response.json["status"] == "failed"


def test_invalid_content_type(client):
    assert client.post("/api/evaluate", data="{}").status_code == 415


def test_invalid_json_duplicate_keys_and_unknown_fields(client):
    for payload in ("{", '{"trace":{},"trace":{}}', '{"trace":{},"unexpected":1}'):
        response = client.post("/api/evaluate", data=payload, content_type="application/json")
        assert response.status_code == 400
        assert response.json["error"]["details"]


def test_null_policy_is_not_silently_defaulted(client, trace):
    assert client.post("/api/evaluate", json={"trace": trace, "policy": None}).status_code == 400


def test_request_body_limit(client):
    response = client.post("/api/evaluate", data=" " * (MAX_BYTES + 1), content_type="application/json")
    assert response.status_code == 413
    assert "512" in response.json["error"]["message"]


def test_export_json_and_junit(client, trace):
    report = client.post("/api/export?format=json", json={"trace": trace})
    assert report.status_code == 200
    assert report.json["status"] == "passed"
    assert "attachment" in report.headers["Content-Disposition"]
    junit = client.post("/api/export?format=junit", json={"trace": trace})
    assert junit.status_code == 200
    assert ET.fromstring(junit.data).attrib["failures"] == "0"


def test_invalid_export_format_and_not_found(client, trace):
    assert client.post("/api/export?format=csv", json={"trace": trace}).status_code == 400
    assert client.get("/api/missing").status_code == 404


def test_invalid_unicode_object_keys_return_400_not_500(client):
    for payload in ('{"trace":{},"\\ud800":0}', '{"trace":{"\\ud800":0}}', '{"trace":{},"policy":{"\\ud800":0}}'):
        response = client.post("/api/evaluate", data=payload, content_type="application/json")
        assert response.status_code == 400
        assert response.json["error"]["details"]
