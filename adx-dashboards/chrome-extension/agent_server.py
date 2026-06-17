#!/usr/bin/env python3
"""
ADX Dashboard Agent Server

A simple HTTP server that bridges between AI agents and the Chrome extension.
Agents POST edit requests here, the extension polls for them and executes.

Usage:
    python agent_server.py [--port 9876]

API:
    POST /edit - Submit a dashboard edit request
    GET /poll?dashboardId=xxx - Extension polls for pending edits  
    POST /result - Extension reports edit results
    GET /status - Check server status
"""

import argparse
import asyncio
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional
from aiohttp import web
from aiohttp.web import middleware

@dataclass
class PendingEdit:
    id: str
    dashboard_id: str
    dashboard: dict
    description: str
    skip_confirmation: bool
    filename: str
    created_at: datetime
    result: Optional[dict] = None
    result_event: asyncio.Event = field(default_factory=asyncio.Event)

@dataclass
class PendingGet:
    id: str
    dashboard_id: str
    created_at: datetime
    result: Optional[dict] = None
    result_event: asyncio.Event = field(default_factory=asyncio.Event)

# In-memory stores
pending_edits: dict[str, PendingEdit] = {}
pending_gets: dict[str, PendingGet] = {}
EDIT_TIMEOUT_SECONDS = 120
GET_TIMEOUT_SECONDS = 10

@middleware
async def cors_middleware(request, handler):
    """Allow CORS from extension"""
    if request.method == 'OPTIONS':
        return web.Response(headers={
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        })
    
    response = await handler(request)
    response.headers['Access-Control-Allow-Origin'] = '*'
    return response


async def handle_status(request):
    """Health check endpoint"""
    return web.json_response({
        'status': 'ok',
        'version': '1.0.0',
        'pending_edits': len(pending_edits)
    })


async def handle_edit(request):
    """
    Submit a dashboard edit request.
    
    POST /edit
    {
        "dashboardId": "uuid",
        "dashboard": { ... },
        "description": "What this edit does",
        "skipConfirmation": false,
        "filename": "agent-edit.json"
    }
    
    Returns when the edit is complete (or times out).
    """
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({'error': 'Invalid JSON'}, status=400)
    
    if 'dashboard' not in data:
        return web.json_response({'error': 'Missing dashboard field'}, status=400)
    
    edit_id = str(uuid.uuid4())
    dashboard_id = data.get('dashboardId', '*')  # * = any dashboard
    
    edit = PendingEdit(
        id=edit_id,
        dashboard_id=dashboard_id,
        dashboard=data['dashboard'],
        description=data.get('description', 'Agent edit'),
        skip_confirmation=data.get('skipConfirmation', False),
        filename=data.get('filename', 'agent-edit.json'),
        created_at=datetime.now()
    )
    
    pending_edits[edit_id] = edit
    
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Edit queued: {edit_id[:8]}... for dashboard {dashboard_id[:8] if dashboard_id != '*' else '*'}...")
    
    # Wait for result (with timeout)
    try:
        await asyncio.wait_for(edit.result_event.wait(), timeout=EDIT_TIMEOUT_SECONDS)
        result = edit.result
        del pending_edits[edit_id]
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Edit completed: {edit_id[:8]}... - {result}")
        return web.json_response(result)
    except asyncio.TimeoutError:
        del pending_edits[edit_id]
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Edit timeout: {edit_id[:8]}...")
        return web.json_response({
            'error': 'Timeout waiting for extension to apply edit',
            'hint': 'Make sure the ADX dashboard is open and the extension is installed'
        }, status=504)


async def handle_poll(request):
    """
    Extension polls for pending commands.
    
    GET /poll?dashboardId=xxx
    
    Returns the next pending edit or get request for this dashboard.
    """
    dashboard_id = request.query.get('dashboardId')
    
    if not dashboard_id:
        return web.json_response({'error': 'Missing dashboardId'}, status=400)
    
    # Check for pending get requests first
    for get_req in pending_gets.values():
        if get_req.result is None:
            if get_req.dashboard_id == '*' or get_req.dashboard_id == dashboard_id:
                return web.json_response({
                    'pendingGet': { 'id': get_req.id, 'dashboardId': get_req.dashboard_id }
                })
    
    # Check for pending edits
    for edit in pending_edits.values():
        if edit.result is None:
            if edit.dashboard_id == '*' or edit.dashboard_id == dashboard_id:
                return web.json_response({
                    'pendingEdit': {
                        'id': edit.id,
                        'dashboardId': edit.dashboard_id,
                        'dashboard': edit.dashboard,
                        'description': edit.description,
                        'skipConfirmation': edit.skip_confirmation,
                        'filename': edit.filename
                    }
                })
    
    return web.json_response({'pendingEdit': None, 'pendingGet': None})


async def handle_result(request):
    """
    Extension reports results for edits or gets.
    
    POST /result
    {
        "editId": "uuid",  // or "getId": "uuid"
        "result": { ... }
    }
    """
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({'error': 'Invalid JSON'}, status=400)
    
    edit_id = data.get('editId')
    get_id = data.get('getId')
    result = data.get('result')
    
    if not result:
        return web.json_response({'error': 'Missing result'}, status=400)
    
    if edit_id and edit_id in pending_edits:
        pending_edits[edit_id].result = result
        pending_edits[edit_id].result_event.set()
        return web.json_response({'ok': True})
    
    if get_id and get_id in pending_gets:
        pending_gets[get_id].result = result
        pending_gets[get_id].result_event.set()
        return web.json_response({'ok': True})
    
    return web.json_response({'error': 'Request not found'}, status=404)


async def handle_dashboard_get(request):
    """
    Get current dashboard JSON from the browser.
    
    GET /dashboard?dashboardId=xxx
    
    Returns the dashboard JSON currently loaded in the browser.
    """
    dashboard_id = request.query.get('dashboardId', '*')
    
    get_id = str(uuid.uuid4())
    get_req = PendingGet(
        id=get_id,
        dashboard_id=dashboard_id,
        created_at=datetime.now()
    )
    pending_gets[get_id] = get_req
    
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Get queued: {get_id[:8]}... for dashboard {dashboard_id[:8] if dashboard_id != '*' else '*'}...")
    
    try:
        await asyncio.wait_for(get_req.result_event.wait(), timeout=GET_TIMEOUT_SECONDS)
        result = get_req.result
        del pending_gets[get_id]
        return web.json_response(result)
    except asyncio.TimeoutError:
        del pending_gets[get_id]
        return web.json_response({
            'error': 'Timeout waiting for dashboard data',
            'hint': 'Make sure the ADX dashboard is open'
        }, status=504)


def create_app():
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get('/status', handle_status)
    app.router.add_get('/dashboard', handle_dashboard_get)
    app.router.add_post('/edit', handle_edit)
    app.router.add_get('/poll', handle_poll)
    app.router.add_post('/result', handle_result)
    # Explicit OPTIONS handlers for CORS preflight
    app.router.add_options('/edit', lambda r: web.Response())
    app.router.add_options('/poll', lambda r: web.Response())
    app.router.add_options('/result', lambda r: web.Response())
    app.router.add_options('/status', lambda r: web.Response())
    app.router.add_options('/dashboard', lambda r: web.Response())
    return app


def main():
    parser = argparse.ArgumentParser(description='ADX Dashboard Agent Server')
    parser.add_argument('--port', type=int, default=9876, help='Port to listen on')
    args = parser.parse_args()
    
    print(f"""
╔═══════════════════════════════════════════════════════════╗
║           ADX Dashboard Agent Server v1.0.0               ║
╠═══════════════════════════════════════════════════════════╣
║  Listening on: http://localhost:{args.port:<24} ║
║                                                           ║
║  Endpoints:                                               ║
║    GET  /dashboard - Fetch current dashboard JSON         ║
║    POST /edit      - Submit dashboard edit                ║
║    GET  /poll      - Poll for edits (extension calls)     ║
║    POST /result    - Report result (extension calls)      ║
║    GET  /status    - Health check                         ║
║                                                           ║
║  Waiting for extension to connect...                      ║
╚═══════════════════════════════════════════════════════════╝
""")
    
    app = create_app()
    web.run_app(app, host='127.0.0.1', port=args.port, print=None)


if __name__ == '__main__':
    main()
