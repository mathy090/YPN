import os
import zipfile
import shutil
import urllib.request

VOSK_MODEL_DIR = os.getenv(
    "VOSK_MODEL_PATH",
    "models/vosk-model-small-en-us-0.15"
)

VOSK_ZIP_URL = (
    "https://alphacephei.com/vosk/models/"
    "vosk-model-small-en-us-0.15.zip"
)


def download(url: str, dest: str):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    urllib.request.urlretrieve(url, dest)


def ensure_vosk():
    if os.path.isdir(VOSK_MODEL_DIR) and os.path.exists(os.path.join(VOSK_MODEL_DIR, "conf")):
        return

    zip_path = VOSK_MODEL_DIR + ".zip"
    temp_dir = "models/_tmp_vosk"

    download(VOSK_ZIP_URL, zip_path)

    if os.path.exists(temp_dir):
        shutil.rmtree(temp_dir)

    os.makedirs(temp_dir, exist_ok=True)

    with zipfile.ZipFile(zip_path, "r") as z:
        z.extractall(temp_dir)

    inner = os.listdir(temp_dir)[0]
    extracted_path = os.path.join(temp_dir, inner)

    if os.path.exists(VOSK_MODEL_DIR):
        shutil.rmtree(VOSK_MODEL_DIR)

    shutil.move(extracted_path, VOSK_MODEL_DIR)

    shutil.rmtree(temp_dir)
    os.remove(zip_path)


if __name__ == "__main__":
    ensure_vosk()