import { socket } from './socket';

/**
 * 通用的 AI 对话函数
 * @param configId 可选，指定使用的配置 ID（不传则使用全局激活配置）
 */
export function callKuyepClaude(userContent: string, systemPrompt: string, configId?: string) {
  return new Promise((resolve, reject) => {
    socket.emit('proxy:claude', {
      message: userContent,
      systemPrompt,
      configId
    }, (response: any) => {
      if (response.success) {
        resolve(response.data);
      } else {
        reject(new Error(response.error));
      }
    });
  });
}