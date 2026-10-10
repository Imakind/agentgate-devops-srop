"""Pure policy evaluator. No model calls, network requests, or tool execution."""

from __future__ import annotations

import ipaddress
import json
import re
from copy import deepcopy
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET

MAX_BYTES = 512 * 1024
MAX_STEPS = 100
DISCLAIMER = (
    "Проверяются только данные загруженного trace. Записи approval предоставлены "
    "автором trace и не аутентифицируются независимо. PASS не гарантирует безопасность агента."
)
DEFAULT_POLICY = {
    "allowed_tools": ["web.search", "web.open", "notes.write", "email.send"],
    "allowed_domains": ["docs.python.org", "flask.palletsprojects.com", "github.com"],
    "approval_required_tools": ["email.send"],
    "max_tokens": 5000,
    "max_tool_calls": 8,
}
CHECKS = {
    "tools": "Разрешённые инструменты",
    "domains": "Домены запросов",
    "approvals": "Заявленные подтверждения",
    "token_budget": "Лимит токенов",
    "call_budget": "Лимит вызовов",
}


class ValidationError(ValueError):
    """Untrusted input is malformed or exceeds the documented limits."""


def _fail(path: str, message: str):
    raise ValidationError(f"{path}: {message}")


def _text(value, path, maximum=500, *, allow_empty=False):
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        _fail(path, "ожидается непустая строка")
    if len(value) > maximum:
        _fail(path, f"не более {maximum} символов")
    # Keep JSON/JUnit exports valid, including against lone surrogate input.
    if any((ord(c) < 32 and c not in "\n\r\t") or 0xD800 <= ord(c) <= 0xDFFF
           or ord(c) in (0xFFFE, 0xFFFF) for c in value):
        _fail(path, "недопустимые управляющие символы")
    return value


def _integer(value, path, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        _fail(path, f"ожидается целое число от {minimum} до {maximum}")
    return value


def _object(value, path, required, optional=()):
    if not isinstance(value, dict):
        _fail(path, "ожидается JSON-объект")
    missing = set(required) - value.keys()
    extra = value.keys() - set(required) - set(optional)
    if missing:
        _fail(path, "нет полей: " + ", ".join(sorted(missing)))
    if extra:
        _fail(path, "неизвестные поля: " + ", ".join(sorted(extra)))


def load_json(data: bytes | str):
    """Decode bounded JSON; reject duplicate keys and non-finite numbers."""
    try:
        raw = data.encode("utf-8") if isinstance(data, str) else data
        if len(raw) > MAX_BYTES:
            raise ValidationError("JSON: размер не должен превышать 512 KiB")
        def pairs(items):
            result = {}
            for key, value in items:
                _text(key, "JSON key", 253)
                if key in result:
                    raise ValidationError(f"JSON: повторяющееся поле {key!r}")
                result[key] = value
            return result
        def constant(value):
            raise ValidationError(f"JSON: недопустимое число {value}")
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        if isinstance(exc, ValidationError):
            raise
        raise ValidationError("JSON: некорректный документ UTF-8 JSON") from exc


def canonical_domain(value: str) -> str:
    """Normalize a hostname, without substring/suffix wildcard matching."""
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValidationError("Домен должен быть именем хоста без пробелов")
    if any(c in value for c in "/\\:@?#%"):
        raise ValidationError("Домен указывается без схемы, порта, пути и wildcard")
    host = value.removesuffix(".").lower()
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise ValidationError("Некорректный IDNA-домен") from exc
    if len(host) > 253 or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                                  for label in host.split(".")):
        raise ValidationError("Некорректный домен")
    # IP literals are allowed only through an exact explicit allowlist entry.
    try:
        host = str(ipaddress.IPv4Address(host))
    except ipaddress.AddressValueError:
        pass
    return host


def url_domain(value: str) -> str:
    if value != value.strip() or any(c.isspace() for c in value) or "\\" in value:
        raise ValidationError("URL содержит пробелы или обратную косую черту")
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("https", "http") or not parsed.hostname:
            raise ValidationError("Допускаются только абсолютные HTTP(S) URL")
        if parsed.username is not None or parsed.password is not None:
            raise ValidationError("URL с учётными данными запрещён")
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValidationError("Некорректный порт URL")
        return canonical_domain(parsed.hostname)
    except ValueError as exc:
        raise ValidationError(f"Некорректный URL: {exc}") from exc


def validate_policy(value):
    _object(value, "policy", DEFAULT_POLICY.keys())
    result = {}
    for field in ("allowed_tools", "allowed_domains", "approval_required_tools"):
        entries = value[field]
        if not isinstance(entries, list) or len(entries) > 100:
            _fail(f"policy.{field}", "ожидается список не более 100 элементов")
        entries = [_text(v, f"policy.{field}", 253) for v in entries]
        if field == "allowed_domains":
            entries = [canonical_domain(v) for v in entries]
        if len(set(entries)) != len(entries):
            _fail(f"policy.{field}", "повторяющиеся значения запрещены")
        result[field] = entries
    result["max_tokens"] = _integer(value["max_tokens"], "policy.max_tokens", 0, 1_000_000)
    result["max_tool_calls"] = _integer(value["max_tool_calls"], "policy.max_tool_calls", 0, MAX_STEPS)
    return result


def validate_trace(value):
    _object(value, "trace", ("id", "name", "steps"), ("description", "approvals"))
    result = {
        "id": _text(value["id"], "trace.id", 100),
        "name": _text(value["name"], "trace.name", 200),
        "description": _text(value.get("description", ""), "trace.description", 2000, allow_empty=True),
        "steps": [], "approvals": [],
    }
    if not isinstance(value["steps"], list) or not 1 <= len(value["steps"]) <= MAX_STEPS:
        _fail("trace.steps", f"нужен список от 1 до {MAX_STEPS} шагов")
    ids = set()
    for index, step in enumerate(value["steps"]):
        path = f"trace.steps[{index}]"
        _object(step, path, ("id", "tool", "tokens"), ("description", "url", "approval_id"))
        item = {
            "id": _text(step["id"], path + ".id", 100),
            "tool": _text(step["tool"], path + ".tool", 100),
            "tokens": _integer(step["tokens"], path + ".tokens", 0, 1_000_000),
            "description": _text(step.get("description", ""), path + ".description", 2000, allow_empty=True),
        }
        if item["id"] in ids:
            _fail(path + ".id", "ID шага должен быть уникальным")
        ids.add(item["id"])
        for field, limit in (("url", 2048), ("approval_id", 100)):
            if field in step:
                item[field] = _text(step[field], path + "." + field, limit)
        result["steps"].append(item)
    approvals = value.get("approvals", [])
    if not isinstance(approvals, list) or len(approvals) > MAX_STEPS:
        _fail("trace.approvals", "ожидается список не более 100 записей")
    approval_ids = set()
    for index, approval in enumerate(approvals):
        path = f"trace.approvals[{index}]"
        _object(approval, path, ("id", "step_id", "tool", "decision"))
        item = {key: _text(approval[key], path + "." + key, 100) for key in approval}
        if item["id"] in approval_ids:
            _fail(path + ".id", "ID подтверждения должен быть уникальным")
        if item["step_id"] not in ids:
            _fail(path + ".step_id", "указанный шаг не существует")
        if item["decision"] not in ("approved", "denied"):
            _fail(path + ".decision", "ожидается approved или denied")
        approval_ids.add(item["id"])
        result["approvals"].append(item)
    return result


def evaluate(trace, policy=None):
    """Return a repeatable policy report; never mutate caller-owned inputs."""
    trace = validate_trace(trace)
    policy = validate_policy(deepcopy(DEFAULT_POLICY) if policy is None else policy)
    approvals = {a["id"]: a for a in trace["approvals"]}
    violations, steps = [], []
    running_tokens = 0
    for index, step in enumerate(trace["steps"]):
        issues = []
        def add(code, message):
            issues.append({"code": code, "message": message, "step_id": step["id"]})
        if step["tool"] not in policy["allowed_tools"]:
            add("tools", f"Инструмент {step['tool']} не разрешён политикой.")
        if "url" in step:
            try:
                host = url_domain(step["url"])
                if host not in policy["allowed_domains"]:
                    add("domains", f"Домен {host} отсутствует в точном allowlist.")
            except ValidationError as exc:
                add("domains", str(exc))
        elif step["tool"] == "web.open":
            add("domains", "Для web.open требуется URL назначения.")
        if step["tool"] in policy["approval_required_tools"]:
            approval = approvals.get(step.get("approval_id"))
            if not approval or (approval["step_id"], approval["tool"], approval["decision"]) != (
                step["id"], step["tool"], "approved"
            ):
                add("approvals", "Нет подходящей записи approved для этого шага и инструмента.")
        running_tokens += step["tokens"]
        if running_tokens > policy["max_tokens"]:
            add("token_budget", f"Накопленные токены: {running_tokens}; лимит: {policy['max_tokens']}.")
        if index + 1 > policy["max_tool_calls"]:
            add("call_budget", f"Вызов №{index + 1} превышает лимит {policy['max_tool_calls']}.")
        violations.extend(issues)
        steps.append({**step, "index": index + 1, "status": "failed" if issues else "passed", "violations": issues})
    passed = sum(s["status"] == "passed" for s in steps)
    return {
        "trace": trace, "policy": policy, "status": "failed" if violations else "passed",
        "summary": {"total_steps": len(steps), "passed_steps": passed, "failed_steps": len(steps) - passed,
                    "total_tokens": running_tokens, "tool_calls": len(steps), "violations": len(violations)},
        "checks": [{"code": code, "label": label, "passed": not any(v["code"] == code for v in violations),
                    "details": f"Нарушений: {sum(v['code'] == code for v in violations)}"}
                   for code, label in CHECKS.items()],
        "steps": steps, "violations": violations, "disclaimer": DISCLAIMER,
    }


def to_junit(report):
    """One testcase per trace step, not per evaluator unit test."""
    suite = ET.Element("testsuite", name="AgentGate: " + report["trace"]["name"],
                       tests=str(report["summary"]["total_steps"]),
                       failures=str(report["summary"]["failed_steps"]), errors="0")
    properties = ET.SubElement(suite, "properties")
    ET.SubElement(properties, "property", name="approval_evidence", value="supplied, not independently authenticated")
    for step in report["steps"]:
        case = ET.SubElement(suite, "testcase", classname="agentgate.trace", name=step["id"] + ": " + step["tool"])
        if step["violations"]:
            failure = ET.SubElement(case, "failure", message=f"{len(step['violations'])} policy violation(s)", type="PolicyViolation")
            failure.text = "\n".join(v["code"] + ": " + v["message"] for v in step["violations"])
    return ET.tostring(suite, encoding="unicode", xml_declaration=True)
