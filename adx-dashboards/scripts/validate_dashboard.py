#!/usr/bin/env python3
"""Validate a dashboard JSON file against the ADX dashboard schema."""

import asyncio
import json
import sys
from pathlib import Path
from urllib.parse import urljoin

import httpx
import jsonschema
from jsonschema import Draft202012Validator

SCHEMA_BASE = "https://dataexplorer.azure.com/static/d/schema/55/"
SCHEMA_URL = f"{SCHEMA_BASE}dashboard.json"


class SchemaResolver:
    """Resolver that fetches referenced schemas from the ADX schema endpoint."""
    
    def __init__(self, client: httpx.AsyncClient, cache: dict):
        self.client = client
        self.cache = cache
    
    async def fetch(self, uri: str) -> dict:
        if uri in self.cache:
            return self.cache[uri]
        
        response = await self.client.get(uri)
        response.raise_for_status()
        schema = response.json()
        self.cache[uri] = schema
        return schema


async def fetch_all_schemas(client: httpx.AsyncClient) -> dict[str, dict]:
    """Fetch the main schema and all referenced schemas."""
    cache = {}
    resolver = SchemaResolver(client, cache)
    
    # Fetch main schema
    main_schema = await resolver.fetch(SCHEMA_URL)
    
    # Fetch referenced schemas (tile, parameter, query, baseQuery)
    refs = ["tile.json", "parameter.json", "query.json", "baseQuery.json"]
    for ref in refs:
        try:
            await resolver.fetch(urljoin(SCHEMA_BASE, ref))
        except httpx.HTTPStatusError:
            pass  # Some refs may not exist or be optional
    
    return cache


def build_registry(schemas: dict[str, dict]):
    """Build a jsonschema registry from fetched schemas."""
    from referencing import Registry, Resource
    
    resources = []
    for uri, schema in schemas.items():
        resources.append((uri, Resource.from_contents(schema)))
    
    return Registry().with_resources(resources)


async def validate_dashboard(json_file: Path) -> dict:
    """Validate a dashboard JSON file against the schema."""
    with open(json_file) as f:
        dashboard = json.load(f)
    
    # Remove metadata fields that aren't part of the schema
    dashboard_to_validate = {k: v for k, v in dashboard.items() if not k.startswith("_")}
    
    async with httpx.AsyncClient() as client:
        schemas = await fetch_all_schemas(client)
    
    main_schema = schemas[SCHEMA_URL]
    
    try:
        # Try using referencing library for proper $ref resolution
        registry = build_registry(schemas)
        validator = Draft202012Validator(main_schema, registry=registry)
        errors = list(validator.iter_errors(dashboard_to_validate))
    except ImportError:
        # Fall back to basic validation without refs
        validator = Draft202012Validator(main_schema)
        errors = list(validator.iter_errors(dashboard_to_validate))
    
    if errors:
        return {
            "valid": False,
            "errors": [
                {
                    "path": list(e.absolute_path),
                    "message": e.message,
                }
                for e in errors
            ]
        }
    
    return {"valid": True}


def main():
    if len(sys.argv) != 2:
        print("Usage: validate_dashboard.py <json_file>", file=sys.stderr)
        sys.exit(1)
    
    json_file = Path(sys.argv[1])
    if not json_file.exists():
        print(json.dumps({"error": f"File not found: {json_file}"}), file=sys.stderr)
        sys.exit(1)
    
    try:
        result = asyncio.run(validate_dashboard(json_file))
        print(json.dumps(result, indent=2))
        if not result["valid"]:
            sys.exit(1)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
