export function apiExamples(base) {
  const curl = `# 设置当前终端的 API Key（输入时不显示；从本机 .env 获取）
read -rs API_KEY; export API_KEY
BASE_URL='${base}'

# 1. 提交一次；保留返回的 task_id
curl "$BASE_URL/v1/videos/generations" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"provider":"doubao-desktop","model":"Seedance 2.0 Fast","prompt":"小狐狸在海边奔跑","duration":6,"ratio":"9:16","async":true,"idempotency_key":"fox-001"}'

# 2. 替换 TASK_ID，重复查询同一任务直到 completed
curl "$BASE_URL/v1/videos/tasks/TASK_ID?wait_seconds=30" \\
  -H "Authorization: Bearer $API_KEY"

# 3. 用完成响应 videos[0].id 替换 VIDEO_ID
curl --fail "$BASE_URL/v1/videos/files/VIDEO_ID" \\
  -H "Authorization: Bearer $API_KEY" -o output.mp4`;
  const python = `# pip install requests
# 先在终端安全设置 API_KEY：read -rs API_KEY; export API_KEY
import os, time, uuid
from pathlib import Path
import requests

base = ${JSON.stringify(base)}
headers = {"Authorization": "Bearer " + os.environ["API_KEY"]}
output = Path("output.mp4")
if output.exists():
    raise RuntimeError("输出文件已存在，请换一个文件名")

def request(method, route, **kwargs):
    response = requests.request(method, base + route, headers=headers, timeout=60, **kwargs)
    response.raise_for_status()
    return response.json()

job = request("POST", "/v1/videos/generations", json={
    "provider": "doubao-desktop", "model": "Seedance 2.0 Fast",
    "prompt": "小狐狸在海边奔跑", "duration": 6, "ratio": "9:16",
    "async": True, "idempotency_key": str(uuid.uuid4())
})
task_id = job["task_id"]
print("任务 ID：", task_id)  # 保存 ID，超时后继续查询，避免重复提交
end = time.monotonic() + 900
while job["status"] in ("running", "submitting"):
    if time.monotonic() >= end:
        raise TimeoutError("查询超时，请用原任务 ID 继续查询：" + task_id)
    job = request("GET", "/v1/videos/tasks/" + task_id + "?wait_seconds=30")
    if job["status"] in ("running", "submitting"):
        time.sleep(1)
if job["status"] != "completed" or not job.get("videos"):
    raise RuntimeError("任务未产出视频：" + job["status"] + "；原任务 ID：" + task_id)
video_id = job["videos"][0]["id"]
response = requests.get(base + "/v1/videos/files/" + video_id, headers=headers, timeout=120)
response.raise_for_status()
if response.content[4:8] != b"ftyp":
    raise RuntimeError("返回内容不是 MP4")
with output.open("xb") as file:
    file.write(response.content)
print("已保存：", output)`;
  return {curl, python};
}
export function setupApiExamples() {
  const examples = apiExamples(location.origin);
  document.getElementById('apiBaseText').textContent = location.origin;
  const select = document.getElementById('apiExampleLanguage');
  const code = document.getElementById('apiExampleCode');
  const render = () => { code.textContent = examples[select.value]; };
  select.addEventListener('change', render); render();
  document.getElementById('copyApiExample').onclick = async () => {
    const notice = document.getElementById('apiCopyNotice');
    try { await navigator.clipboard.writeText(code.textContent); notice.textContent = '示例已复制；请在自己的终端设置 API_KEY。'; }
    catch { notice.textContent = '浏览器不允许复制，请手动选中示例复制。'; }
  };
}
