import { io } from "socket.io-client";

// 根据环境判断地址
const URL = import.meta.env.DEV ? "http://localhost:2117" : "/";

// 导出唯一的 socket 实例
export const socket = io(URL);