const descriptions = {
  client_unavailable: ['豆包客户端未连接，请启动带调试接口的豆包客户端后重试。', 'check_connection'],
  login_required: ['请在豆包客户端完成登录，再重新检查连接。', 'login'],
  client_not_ready: ['豆包客户端尚未加载聊天界面，请打开聊天页面后重试。', 'check_connection'],
  client_incompatible: ['当前豆包客户端内部接口不兼容，请更新桥接程序后重试。', 'update_bridge'],
  cdp_timeout: ['读取豆包客户端超时，任务保留；恢复连接后继续查询原任务。', 'refresh_task'],
  connection_lost: ['豆包连接暂时中断，任务保留；恢复连接后继续查询原任务。', 'refresh_task'],
  submit_unknown: ['提交结果未确认，禁止自动重发；请在豆包客户端核对本次会话。', 'check_conversation'],
  confirmation_unknown: ['确认操作结果未确认，请在豆包客户端查看；不会重复点击生成。', 'check_conversation'],
  reference_unreadable: ['豆包明确报告原图无法读取，本次不接受重绘结果；请核对附件后新建草稿。原任务的取消结果单独列出。', 'check_conversation'],
  status_unknown: ['暂时无法确认豆包任务状态，请继续查询原任务。', 'refresh_task'],
  extraction_failed: ['豆包任务已完成，但下载或校验失败；可重新提取，不必重新生成。', 'retry_extraction'],
  delivery_unknown: ['云盘补交操作结果未确认；请在豆包查看原会话。不会重复补交或重新生成。', 'check_conversation'],
  cloud_video_missing: ['豆包已完成，但未找到可核验的云盘视频来源；不会下载视频卡版本。请在豆包补交云盘文件后重新查询。', 'refresh_task'],
  local_storage_error: ['本机任务文件保存失败，尚未提交；检查磁盘空间和目录权限后重试。', 'check_storage'],
  monitoring_expired: ['任务监控已超过一小时，已暂停后台查询；可继续查询原任务，不会重新生成。', 'refresh_task'],
};

export function videoDiagnostic(code, extra = {}) {
  const [message, nextAction] = descriptions[code] || descriptions.status_unknown;
  return { code, message, next_action: nextAction, ...extra };
}

export function videoError(code, extra = {}) {
  const diagnostic = videoDiagnostic(code, extra);
  return Object.assign(new Error(diagnostic.message), diagnostic, { httpStatus: code === 'login_required' ? 409 : 503 });
}

export function classifyVideoError(error) {
  if (descriptions[error?.code]) return error.code;
  const message = String(error?.message || '');
  if (/timeout|timed out|超时/i.test(message)) return 'cdp_timeout';
  if (/module.*unavailable|ambiguous|webpack|is not a function/i.test(message)) return 'client_incompatible';
  if (/sign in|logged.?out|未登录|登录失效/i.test(message)) return 'login_required';
  return 'connection_lost';
}

// Closing the socket on timeout cancels an outstanding read instead of
// leaving an unbounded promise at the front of the shared CDP lane.
export async function boundedCdp(work, close, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => { reject(videoError('cdp_timeout')); try { close(); } catch {} }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
