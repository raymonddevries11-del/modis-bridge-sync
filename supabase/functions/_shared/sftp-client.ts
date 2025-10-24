// Simple SFTP client wrapper using ssh2 via npm CDN
// Note: ssh2-sftp-client has issues in Deno. Using a simpler fetch-based approach for SFTP operations.

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

export interface FileInfo {
  name: string;
  type: string;
  size: number;
  modifyTime: number;
}

// Helper to execute SFTP commands via subprocess
async function execSftpCommand(config: SftpConfig, commands: string[]): Promise<string> {
  const keyFile = await Deno.makeTempFile();
  await Deno.writeTextFile(keyFile, config.privateKey);
  
  try {
    const batchFile = await Deno.makeTempFile();
    await Deno.writeTextFile(batchFile, commands.join('\n'));
    
    const process = new Deno.Command('sftp', {
      args: [
        '-i', keyFile,
        '-P', config.port.toString(),
        '-b', batchFile,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        `${config.username}@${config.host}`
      ],
      stdout: 'piped',
      stderr: 'piped',
    });
    
    const { stdout, stderr } = await process.output();
    const output = new TextDecoder().decode(stdout);
    const errorOutput = new TextDecoder().decode(stderr);
    
    await Deno.remove(batchFile);
    
    if (errorOutput && !errorOutput.includes('Connecting to')) {
      console.error('SFTP stderr:', errorOutput);
    }
    
    return output;
  } finally {
    await Deno.remove(keyFile);
  }
}

export class SftpClient {
  private config: SftpConfig | null = null;

  async connect(config: SftpConfig): Promise<void> {
    this.config = config;
    console.log('SFTP connection configured');
  }

  async listFiles(remotePath: string): Promise<FileInfo[]> {
    if (!this.config) throw new Error('Not connected');
    
    try {
      const output = await execSftpCommand(this.config, [`ls -l ${remotePath}`]);
      const files: FileInfo[] = [];
      
      const lines = output.split('\n').filter(line => line.trim() && !line.startsWith('sftp>'));
      
      for (const line of lines) {
        // Parse ls -l output: -rw-r--r--  1 user group 1234 Jan 01 12:00 filename.xml
        const match = line.match(/^(-|d)[rwx-]+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+[\d:]+\s+(.+)$/);
        if (match && match[1] === '-') {
          files.push({
            name: match[3],
            type: '-',
            size: parseInt(match[2]),
            modifyTime: Date.now(), // Simplified
          });
        }
      }
      
      return files;
    } catch (error) {
      console.error('List files error:', error);
      return [];
    }
  }

  async downloadFile(remotePath: string): Promise<string> {
    if (!this.config) throw new Error('Not connected');
    
    const localFile = await Deno.makeTempFile();
    
    try {
      await execSftpCommand(this.config, [`get ${remotePath} ${localFile}`]);
      const content = await Deno.readTextFile(localFile);
      return content;
    } finally {
      await Deno.remove(localFile);
    }
  }

  async uploadFile(remotePath: string, content: string): Promise<void> {
    if (!this.config) throw new Error('Not connected');
    
    const localFile = await Deno.makeTempFile();
    
    try {
      await Deno.writeTextFile(localFile, content);
      await execSftpCommand(this.config, [`put ${localFile} ${remotePath}`]);
      console.log(`File uploaded: ${remotePath}`);
    } finally {
      await Deno.remove(localFile);
    }
  }

  async moveFile(fromPath: string, toPath: string): Promise<void> {
    if (!this.config) throw new Error('Not connected');
    
    await execSftpCommand(this.config, [`rename ${fromPath} ${toPath}`]);
    console.log(`File moved: ${fromPath} → ${toPath}`);
  }

  async deleteFile(remotePath: string): Promise<void> {
    if (!this.config) throw new Error('Not connected');
    
    await execSftpCommand(this.config, [`rm ${remotePath}`]);
    console.log(`File deleted: ${remotePath}`);
  }

  async ensureDir(remotePath: string): Promise<void> {
    if (!this.config) throw new Error('Not connected');
    
    try {
      await execSftpCommand(this.config, [`mkdir ${remotePath}`]);
      console.log(`Directory created: ${remotePath}`);
    } catch (error) {
      // Directory might already exist, ignore error
      console.log(`Directory already exists or created: ${remotePath}`);
    }
  }

  async disconnect(): Promise<void> {
    this.config = null;
    console.log('SFTP connection closed');
  }
}
