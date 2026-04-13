# test_ws.py (Updated)
import asyncio
import websockets

URI = "wss://ypn-1-7rwd.onrender.com/voice"

async def test_stream():
    print(f"🔌 Connecting to {URI}...")
    try:
        # CRITICAL: Increase timeout to 60s for Render Cold Starts
        async with websockets.connect(URI, open_timeout=60) as websocket:
            print("✅ Connected! Sending dummy audio...")
            
            # Send 2 seconds of silence
            silence = bytes([0] * 32000) 
            await websocket.send(silence)
            
            print("⏳ Waiting for response...")
            try:
                response = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                print(f"📩 Server Reply: {response}")
            except asyncio.TimeoutError:
                print("⚠️ Timeout (Normal for silence): Server is listening but heard no speech.")
                
    except Exception as e:
        print(f"❌ Connection Failed: {e}")

if __name__ == "__main__":
    asyncio.run(test_stream())