#!/usr/bin/env python3
"""Get a single ADX dashboard by ID."""

import asyncio
import json
import sys

import httpx
from azure.identity import DefaultAzureCredential

API_BASE = "https://dashboards.kusto.windows.net"
SCOPE = "https://rtd-metadata.azurewebsites.net/.default"


async def get_dashboard(dashboard_id: str) -> dict:
    credential = DefaultAzureCredential()
    token = credential.get_token(SCOPE)
    
    headers = {
        "Authorization": f"Bearer {token.token}",
        "Accept": "application/json",
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.get(f"{API_BASE}/dashboards/{dashboard_id}", headers=headers)
        response.raise_for_status()
        
        data = response.json()
        # Include eTag in metadata for updates
        if "etag" in response.headers:
            data["_metadata"] = {"eTag": response.headers["etag"]}
        return data


def main():
    if len(sys.argv) != 2:
        print("Usage: get_dashboard.py <dashboard_id>", file=sys.stderr)
        sys.exit(1)
    
    dashboard_id = sys.argv[1]
    
    try:
        dashboard = asyncio.run(get_dashboard(dashboard_id))
        print(json.dumps(dashboard, indent=2))
    except httpx.HTTPStatusError as e:
        print(json.dumps({"error": str(e), "status_code": e.response.status_code}), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
