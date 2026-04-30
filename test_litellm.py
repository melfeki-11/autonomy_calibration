#!/usr/bin/env python3
"""Smoke test the internal LiteLLM proxy.

Credentials stay out of files. The script reads the LiteLLM key from
ANTHROPIC_AUTH_TOKEN, HIL_BENCH, LITELLM_PROXY_API_KEY, LITELLM_API_KEY, or AWS
Secrets Manager key HIL_BENCH in team/GENAIML/secret-store-key.
"""

from __future__ import annotations

import json
import os
import socket
import sys
from urllib.parse import urlparse

import litellm

DEFAULT_BASE_URL = "https://litellm-proxy.ml-serving-internal.scale.com"
DEFAULT_MODEL = "claude-sonnet-4-6"
AWS_SECRET_ID = "team/GENAIML/secret-store-key"
AWS_REGION = "us-west-2"


def get_base_url() -> str:
    return (
        os.getenv("LITELLM_BASE_URL")
        or os.getenv("ANTHROPIC_BASE_URL")
        or DEFAULT_BASE_URL
    )


def get_api_key() -> str | None:
    env_key = (
        os.getenv("ANTHROPIC_AUTH_TOKEN")
        or os.getenv("HIL_BENCH")
        or os.getenv("LITELLM_PROXY_API_KEY")
        or os.getenv("LITELLM_API_KEY")
    )
    if env_key:
        return env_key

    try:
        import boto3

        session = boto3.Session(
            profile_name=os.getenv("AWS_PROFILE"),
            region_name=os.getenv("AWS_REGION", AWS_REGION),
        )
        client = session.client("secretsmanager")
        response = client.get_secret_value(SecretId=AWS_SECRET_ID)
        return json.loads(response["SecretString"]).get("HIL_BENCH")
    except Exception as exc:
        print(f"Warning: could not load HIL_BENCH from AWS Secrets Manager: {exc}")
        return None


def resolve_provider_model(model: str) -> tuple[str, str]:
    if "/" in model:
        return tuple(model.split("/", 1))  # type: ignore[return-value]
    provider = "anthropic" if model.startswith("claude") else "openai"
    return provider, model


def main() -> int:
    base_url = get_base_url()
    api_key = get_api_key()
    model = os.getenv("LITELLM_MODEL", DEFAULT_MODEL)

    if not api_key:
        sys.exit(
            "Missing ANTHROPIC_AUTH_TOKEN, HIL_BENCH, LITELLM_PROXY_API_KEY, "
            "or LITELLM_API_KEY. Set AWS_PROFILE if using Secrets Manager."
        )

    host = urlparse(base_url).hostname
    try:
        socket.getaddrinfo(host, 443)
    except OSError as exc:
        sys.exit(f"LiteLLM DNS failed for {host}: {exc}")

    provider, model_name = resolve_provider_model(model)
    response = litellm.completion(
        model=f"litellm_proxy/{provider}/{model_name}",
        messages=[{"role": "user", "content": "Reply with exactly PONG."}],
        api_key=api_key,
        base_url=base_url,
        max_tokens=8,
    )

    print(f"LiteLLM proxy reachable: {base_url}")
    print(f"Model: {provider}/{model_name}")
    print("LiteLLM works:", response.choices[0].message.content)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        sys.exit(f"LiteLLM call failed: {exc}")
