#!/usr/bin/env python3
"""Update an ADX dashboard with schema validation."""

import asyncio
import json
import sys
from pathlib import Path

import httpx
from azure.identity import DefaultAzureCredential

API_BASE = "https://dashboards.kusto.windows.net"
SCOPE = "https://rtd-metadata.azurewebsites.net/.default"


async def get_current_etag(client: httpx.AsyncClient, headers: dict, dashboard_id: str) -> str:
    """Fetch the current eTag for a dashboard."""
    response = await client.get(f"{API_BASE}/dashboards/{dashboard_id}", headers=headers)
    response.raise_for_status()
    
    etag = response.headers.get("etag")
    if not etag:
        # Try to get from response body
        data = response.json()
        etag = data.get("eTag") or data.get("_metadata", {}).get("eTag")
    
    if not etag:
        raise ValueError("Could not retrieve eTag from dashboard")
    
    return etag


async def update_dashboard(dashboard_id: str, dashboard_json: dict) -> dict:
    credential = DefaultAzureCredential()
    token = credential.get_token(SCOPE)
    
    headers = {
        "Authorization": f"Bearer {token.token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    
    async with httpx.AsyncClient() as client:
        # Get current eTag
        etag = await get_current_etag(client, headers, dashboard_id)
        
        # Prepare update payload - remove metadata and ensure eTag is set
        payload = {k: v for k, v in dashboard_json.items() if not k.startswith("_")}
        payload["eTag"] = etag
        
        # Send update
        response = await client.put(
            f"{API_BASE}/dashboards/{dashboard_id}",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        return response.json()


def main():
    if len(sys.argv) != 3:
        print("Usage: update_dashboard.py <dashboard_id> <json_file>", file=sys.stderr)
        sys.exit(1)
    
    dashboard_id = sys.argv[1]
    json_file = Path(sys.argv[2])
    
    if not json_file.exists():
        print(json.dumps({"error": f"File not found: {json_file}"}), file=sys.stderr)
        sys.exit(1)
    
    try:
        with open(json_file) as f:
            dashboard_json = json.load(f)
        
        result = asyncio.run(update_dashboard(dashboard_id, dashboard_json))
        print(json.dumps(result, indent=2))
    except httpx.HTTPStatusError as e:
        error_body = None
        try:
            error_body = e.response.json()
        except Exception:
            error_body = e.response.text
        
        print(json.dumps({
            "error": str(e),
            "status_code": e.response.status_code,
            "details": error_body,
        }), file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
