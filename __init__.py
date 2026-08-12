import os
import sys
import base64
import ctypes
import subprocess
import urllib.parse
from datetime import datetime
from PIL import Image
from server import PromptServer
from aiohttp import web
import folder_paths
from nodes import LoadImage

try:
    from nodes import LoadImageMask
    HAS_LOAD_IMAGE_MASK = True
except ImportError:
    HAS_LOAD_IMAGE_MASK = False

try:
    from nodes import LoadImageOutput
    HAS_LOAD_IMAGE_OUTPUT = True
except ImportError:
    HAS_LOAD_IMAGE_OUTPUT = False

# Save the original INPUT_TYPES method
original_input_types = {
    "LoadImage": LoadImage.INPUT_TYPES
}

if HAS_LOAD_IMAGE_MASK:
    original_input_types["LoadImageMask"] = LoadImageMask.INPUT_TYPES

if HAS_LOAD_IMAGE_OUTPUT:
    original_input_types["LoadImageOutput"] = LoadImageOutput.INPUT_TYPES

# Path to the thumbnails directory
THUMBNAILS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "thumbnails")
if not os.path.exists(THUMBNAILS_DIR):
    os.makedirs(THUMBNAILS_DIR, exist_ok=True)

# Native implementation to send files to trash without third-party dependencies (like send2trash)
def send_to_trash_native(file_path: str):
    file_path = os.path.abspath(file_path)
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    # 1. Check if third-party send2trash is available anyway
    try:
        from send2trash import send2trash
        send2trash(file_path)
        return
    except ImportError:
        pass

    # 2. Windows native Shell API via ctypes
    if sys.platform == "win32":
        try:
            from ctypes import wintypes

            class SHFILEOPSTRUCTW(ctypes.Structure):
                _fields_ = [
                    ("hwnd", wintypes.HWND),
                    ("wFunc", wintypes.UINT),
                    ("pFrom", wintypes.LPCWSTR),
                    ("pTo", wintypes.LPCWSTR),
                    ("fFlags", wintypes.WORD),
                    ("fAnyOperationsAborted", wintypes.BOOL),
                    ("hNameMappings", wintypes.LPVOID),
                    ("lpszProgressTitle", wintypes.LPCWSTR),
                ]

            FO_DELETE = 0x0003
            FOF_ALLOWUNDO = 0x0040
            FOF_NOCONFIRMATION = 0x0010
            FOF_SILENT = 0x0004
            FOF_NOERRORUI = 0x0400

            # pFrom must be double null terminated
            pfrom = file_path + "\0\0"

            fileop = SHFILEOPSTRUCTW()
            fileop.hwnd = None
            fileop.wFunc = FO_DELETE
            fileop.pFrom = pfrom
            fileop.pTo = None
            fileop.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI

            res = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(fileop))
            if res == 0 and not fileop.fAnyOperationsAborted and not os.path.exists(file_path):
                return
        except Exception as e:
            print(f"[ComfyUI-Load-Image-Gallery] Windows native trash failed: {e}")

    # 3. macOS native via AppleScript
    elif sys.platform == "darwin":
        try:
            cmd = ["osascript", "-e", f'tell application "Finder" to delete POSIX file "{file_path}"']
            res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if res.returncode == 0 and not os.path.exists(file_path):
                return
        except Exception as e:
            print(f"[ComfyUI-Load-Image-Gallery] macOS native trash failed: {e}")

    # 4. Linux / Unix XDG Trash Specification
    elif sys.platform.startswith("linux"):
        try:
            xdg_data = os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))
            trash_dir = os.path.join(xdg_data, "Trash")
            files_dir = os.path.join(trash_dir, "files")
            info_dir = os.path.join(trash_dir, "info")
            os.makedirs(files_dir, exist_ok=True)
            os.makedirs(info_dir, exist_ok=True)

            base_name = os.path.basename(file_path)
            dest_file = os.path.join(files_dir, base_name)
            dest_info = os.path.join(info_dir, f"{base_name}.trashinfo")

            counter = 1
            name_part, ext_part = os.path.splitext(base_name)
            while os.path.exists(dest_file):
                base_name = f"{name_part}.{counter}{ext_part}"
                dest_file = os.path.join(files_dir, base_name)
                dest_info = os.path.join(info_dir, f"{base_name}.trashinfo")
                counter += 1

            deletion_date = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            file_url = urllib.parse.quote(file_path)
            info_content = f"[Trash Info]\nPath={file_url}\nDeletionDate={deletion_date}\n"

            with open(dest_info, "w", encoding="utf-8") as f:
                f.write(info_content)
            os.rename(file_path, dest_file)
            return
        except Exception as e:
            print(f"[ComfyUI-Load-Image-Gallery] Linux native XDG trash failed: {e}")

    # Fallback to standard remove if trash operation wasn't possible
    os.remove(file_path)

# Get safe filename for thumbnail
def get_thumbnail_path(filename):
    safe_filename = filename.replace(os.sep, "__").replace("/", "__").replace("\\", "__").replace(" ", "_")
    return os.path.join(THUMBNAILS_DIR, f"{safe_filename}.webp")

# Create thumbnail from image file
def create_thumbnail(file_path, size=(80, 80)):
    try:
        img = Image.open(file_path)

        # Calculate aspect ratio
        width, height = img.size
        aspect_ratio = width / height

        # Crop to square from center
        if aspect_ratio > 1:
            new_width = height
            left = (width - new_width) // 2
            img = img.crop((left, 0, left + new_width, height))
        else:
            new_height = width
            top = (height - new_height) // 2
            img = img.crop((0, top, width, top + new_height))

        # Resize to thumbnail size
        img = img.resize(size, Image.LANCZOS)

        # Save as WebP
        rel_path = os.path.relpath(file_path, folder_paths.get_input_directory())
        thumbnail_path = get_thumbnail_path(rel_path)
        img.save(thumbnail_path, "WEBP", quality=80)

        return thumbnail_path
    except Exception as e:
        print(f"Error creating thumbnail for {file_path}: {str(e)}")
        return None

def get_enhanced_files():
    input_dir = folder_paths.get_input_directory()
    exclude_folders = ["clipspace", "3d"]
    additional_files = []

    for root, dirs, files in os.walk(input_dir, followlinks=True):
        if root == input_dir:
            continue
        rel_path = os.path.relpath(root, input_dir)
        parts = rel_path.split(os.sep)

        if any(part in exclude_folders for part in parts):
            continue
        dirs[:] = [d for d in dirs if d not in exclude_folders]

        for file in files:
            if not folder_paths.filter_files_content_types(files, ["image"]):
                continue

            file_path = os.path.join(root, file)
            rel_file_path = os.path.relpath(file_path, input_dir)

            additional_files.append(rel_file_path)

            thumbnail_path = get_thumbnail_path(rel_file_path)
            if not os.path.exists(thumbnail_path):
                create_thumbnail(file_path)
    return sorted(list(dict.fromkeys(additional_files)))

@classmethod
def enhanced_load_image_input_types(cls):
    original_result = original_input_types["LoadImage"]()
    original_files = original_result["required"]["image"][0]
    additional_files = get_enhanced_files()

    combined_files = list(dict.fromkeys(list(original_files) + additional_files))
    original_result["required"]["image"] = (sorted(combined_files), original_result["required"]["image"][1])
    return original_result

LoadImage.INPUT_TYPES = enhanced_load_image_input_types

if HAS_LOAD_IMAGE_MASK:
    @classmethod
    def enhanced_load_image_mask_input_types(cls):
        original_result = original_input_types["LoadImageMask"]()
        if "required" in original_result and "image" in original_result["required"]:
            param_name = "image"
        elif "required" in original_result and "mask" in original_result["required"]:
            param_name = "mask"
        else:
            return original_result

        original_files = original_result["required"][param_name][0]
        additional_files = get_enhanced_files()

        if isinstance(original_files, list):
            combined_files = list(dict.fromkeys(original_files + additional_files))
            original_result["required"][param_name] = (sorted(combined_files), original_result["required"][param_name][1])

        return original_result

    LoadImageMask.INPUT_TYPES = enhanced_load_image_mask_input_types

if HAS_LOAD_IMAGE_OUTPUT:
    @classmethod
    def enhanced_load_image_output_input_types(cls):
        original_result = original_input_types["LoadImageOutput"]()
        if "required" in original_result and "image" in original_result["required"]:
            param_name = "image"
        else:
            return original_result

        original_files = original_result["required"][param_name][0]
        additional_files = get_enhanced_files()

        if isinstance(original_files, list):
            combined_files = list(dict.fromkeys(original_files + additional_files))
            original_result["required"][param_name] = (sorted(combined_files), original_result["required"][param_name][1])
        elif isinstance(original_files, str):
            original_result["required"][param_name] = (original_files, original_result["required"][param_name][1])

        return original_result

    LoadImageOutput.INPUT_TYPES = enhanced_load_image_output_input_types


async def delete_file(request):
    try:
        data = await request.json()
        raw_filename = data.get('filename')
        if not raw_filename:
            return web.Response(status=400, text="Filename not provided")

        filename = os.path.normpath(raw_filename).lstrip('/\\')
        input_dir = os.path.abspath(folder_paths.get_input_directory())
        file_path = os.path.abspath(os.path.join(input_dir, filename))

        if not file_path.startswith(input_dir):
            return web.Response(status=403, text="Access denied")

        if not os.path.exists(file_path):
            return web.Response(status=404, text="File not found")

        thumbnail_path = get_thumbnail_path(filename)
        if os.path.exists(thumbnail_path):
            try:
                os.remove(thumbnail_path)
            except Exception:
                pass

        try:
            send_to_trash_native(file_path)
            message = "File moved to trash successfully"
        except Exception as delete_err:
            print(f"Error during trash operation, falling back to remove: {delete_err}")
            os.remove(file_path)
            message = "File deleted successfully"

        return web.Response(status=200, text=message)
    except Exception as e:
        print(f"Error deleting file: {str(e)}")
        return web.Response(status=500, text="Internal server error")

async def get_thumbnail(request):
    try:
        filename = request.match_info['filename']
        filename = os.path.normpath(filename).lstrip('/\\')
        thumbnail_path = get_thumbnail_path(filename)

        if not os.path.exists(thumbnail_path):
            input_dir = os.path.abspath(folder_paths.get_input_directory())
            file_path = os.path.abspath(os.path.join(input_dir, filename))

            if not file_path.startswith(input_dir):
                return web.Response(status=403, text="Access denied")

            if os.path.exists(file_path):
                thumbnail_path = create_thumbnail(file_path)
                if not thumbnail_path:
                    return web.Response(status=404, text="Failed to create thumbnail")
            else:
                return web.Response(status=404, text="Image file not found")

        return web.FileResponse(thumbnail_path)
    except Exception as e:
        print(f"Error getting thumbnail: {str(e)}")
        return web.Response(status=500, text="Internal server error")

async def get_thumbnails_batch(request):
    try:
        data = await request.json()
        filenames = data.get('filenames', [])

        if not filenames:
            return web.Response(status=400, text="No filenames provided")

        result = {}
        input_dir = os.path.abspath(folder_paths.get_input_directory())

        for filename in filenames:
            norm_filename = os.path.normpath(filename).lstrip('/\\')
            thumbnail_path = get_thumbnail_path(norm_filename)
            if not os.path.exists(thumbnail_path):
                file_path = os.path.abspath(os.path.join(input_dir, norm_filename))
                if file_path.startswith(input_dir) and os.path.exists(file_path):
                    thumbnail_path = create_thumbnail(file_path)

            if thumbnail_path and os.path.exists(thumbnail_path):
                with open(thumbnail_path, "rb") as f:
                    file_content = f.read()
                    base64_data = base64.b64encode(file_content).decode('utf-8')
                    result[filename] = f"data:image/webp;base64,{base64_data}"

        return web.json_response(result)
    except Exception as e:
        print(f"Error getting thumbnails batch: {str(e)}")
        return web.Response(status=500, text="Internal server error")

async def cleanup_thumbnails(request):
    try:
        data = await request.json()
        active_files = data.get('active_files', [])

        if not active_files:
            return web.Response(status=400, text="No active files provided")

        thumbnails = [f for f in os.listdir(THUMBNAILS_DIR) if f.endswith('.webp')]
        removed_count = 0

        active_thumbnails = [get_thumbnail_path(os.path.normpath(f).lstrip('/\\')).split(os.sep)[-1] for f in active_files]

        for thumbnail in thumbnails:
            if thumbnail not in active_thumbnails:
                try:
                    os.remove(os.path.join(THUMBNAILS_DIR, thumbnail))
                    removed_count += 1
                except Exception:
                    pass

        return web.Response(status=200, text=f"Removed {removed_count} stale thumbnails")
    except Exception as e:
        print(f"Error cleaning up thumbnails: {str(e)}")
        return web.Response(status=500, text="Internal server error")

async def check_thumbnails_service(request):
    try:
        if os.path.exists(THUMBNAILS_DIR):
            return web.Response(status=200, text="Thumbnails service is available")
        else:
            try:
                os.makedirs(THUMBNAILS_DIR, exist_ok=True)
                return web.Response(status=200, text="Thumbnails directory created")
            except Exception:
                return web.Response(status=500, text="Could not create thumbnails directory")
    except Exception as e:
        print(f"Error checking thumbnails service: {str(e)}")
        return web.Response(status=500, text="Internal server error")

def register_routes():
    server_instance = getattr(PromptServer, 'instance', None)
    if server_instance is not None:
        server_instance.routes.post("/delete_file")(delete_file)
        server_instance.routes.get("/get_thumbnail/{filename:.*}")(get_thumbnail)
        server_instance.routes.post("/get_thumbnails_batch")(get_thumbnails_batch)
        server_instance.routes.post("/cleanup_thumbnails")(cleanup_thumbnails)
        server_instance.routes.get("/check_thumbnails_service")(check_thumbnails_service)

register_routes()

NODE_CLASS_MAPPINGS = {}
WEB_DIRECTORY = "./js"
__all__ = ['NODE_CLASS_MAPPINGS', 'WEB_DIRECTORY']