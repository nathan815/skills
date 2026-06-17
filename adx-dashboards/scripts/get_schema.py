#!/usr/bin/env python3
"""Fetch the ADX dashboard JSON schema."""

import asyncio
import json
import sys

import httpx

SCHEMA_URL = "https://dataexplorer.azure.com/static/d/schema/55/dashboard.json"


async def get_schema() -> dict:
    async with httpx.AsyncClient() as client:
        response = await client.get(SCHEMA_URL)
        response.raise_for_status()
        return response.json()


def main():
    try:
        schema = asyncio.run(get_schema())
        print(json.dumps(schema, indent=2))
    except httpx.HTTPStatusError as e:
        print(json.dumps({"error": str(e), "status_code": e.response.status_code}), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
