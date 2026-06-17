#!/usr/bin/env python3
"""List all ADX dashboards accessible to the current user."""

import asyncio
import json
import sys

import httpx
from azure.identity import DefaultAzureCredential

API_BASE = "https://dashboards.kusto.windows.net"
SCOPE = "https://rtd-metadata.azurewebsites.net/.default"


async def list_dashboards() -> list[dict]:
    credential = DefaultAzureCredential()
    token = credential.get_token(SCOPE)
    
    headers = {
        "Authorization": f"Bearer {token.token}",
        "Accept": "application/json",
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.get(f"{API_BASE}/api/dashboards", headers=headers)
        response.raise_for_status()
        return response.json()


def main():
    try:
        dashboards = asyncio.run(list_dashboards())
        print(json.dumps(dashboards, indent=2))
    except httpx.HTTPStatusError as e:
        print(json.dumps({"error": str(e), "status_code": e.response.status_code}), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
