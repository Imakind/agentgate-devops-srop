"""Local, stateless Flask UI/API. Bind only to loopback by default."""

from importlib.resources import files
import json

from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import HTTPException

from agentgate import __version__
from agentgate.core import DEFAULT_POLICY, MAX_BYTES, ValidationError, _object, evaluate, load_json, to_junit


def examples():
    return [load_json(path.read_bytes()) for path in sorted(files("agentgate").joinpath("fixtures").iterdir())
            if path.name.endswith(".json")]


def create_app():
    app = Flask(__name__, static_folder="static", static_url_path="/static")
    app.config.update(MAX_CONTENT_LENGTH=MAX_BYTES, JSON_SORT_KEYS=False)
    app.json.ensure_ascii = False

    @app.after_request
    def headers(response):
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/")
    def index():
        return app.send_static_file("index.html")

    @app.get("/api/health")
    def health():
        return jsonify(status="ok", version=__version__)

    @app.get("/api/examples")
    def get_examples():
        return jsonify(examples=examples())

    @app.get("/api/policy")
    def get_policy():
        return jsonify(policy=DEFAULT_POLICY)

    def read_evaluation():
        if not request.is_json:
            return None, (jsonify(error={"message": "Ожидается Content-Type: application/json", "details": []}), 415)
        payload = load_json(request.get_data(cache=False))
        _object(payload, "request", ("trace",), ("policy",))
        if "policy" in payload and payload["policy"] is None:
            raise ValidationError("policy: ожидается JSON-объект")
        return evaluate(payload["trace"], payload.get("policy")), None

    @app.post("/api/evaluate")
    def evaluate_api():
        report, error = read_evaluation()
        return error if error else jsonify(report)

    @app.post("/api/export")
    def export_api():
        format_name = request.args.get("format", "json")
        if format_name not in ("json", "junit"):
            raise ValidationError("format: ожидается json или junit")
        report, error = read_evaluation()
        if error:
            return error
        output = to_junit(report) if format_name == "junit" else json.dumps(report, ensure_ascii=False, indent=2)
        extension, mime = ("xml", "application/xml") if format_name == "junit" else ("json", "application/json")
        return Response(output, mimetype=mime, headers={"Content-Disposition": f'attachment; filename="agentgate-report.{extension}"'})

    @app.errorhandler(ValidationError)
    def invalid(exc):
        return jsonify(error={"message": "Проверьте входные данные", "details": [str(exc)]}), 400

    @app.errorhandler(HTTPException)
    def http_error(exc):
        return jsonify(error={"message": "Максимальный размер запроса — 512 KiB" if exc.code == 413 else exc.description,
                              "details": []}), exc.code

    return app
