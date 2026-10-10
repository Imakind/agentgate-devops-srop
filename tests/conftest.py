from copy import deepcopy
import pytest
from agentgate.app import create_app, examples
from agentgate.core import DEFAULT_POLICY


@pytest.fixture
def trace():
    return deepcopy(examples()[0]["trace"])


@pytest.fixture
def policy():
    return deepcopy(DEFAULT_POLICY)


@pytest.fixture
def client():
    app = create_app()
    app.config["TESTING"] = True
    return app.test_client()
