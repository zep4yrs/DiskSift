// 静态资源模块声明（vite 内置处理 png 导入，TS 需要类型占位）
declare module '*.png' {
  const src: string;
  export default src;
}
