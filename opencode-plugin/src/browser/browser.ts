export const openBrowser = async (url: string): Promise<void> => {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const processHandle = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) throw new Error(`打开浏览器失败，退出码 ${exitCode}`);
};
