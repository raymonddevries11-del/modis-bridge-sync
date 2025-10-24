// SFTP client using ssh2-sftp-client via esm.sh for Supabase Edge Functions
// @deno-types="https://esm.sh/v135/@types/ssh2-sftp-client@9.0.3/index.d.ts"
import SftpClientLib from 'https://esm.sh/ssh2-sftp-client@10.0.3';

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

export class SftpClient {
  private client: any = null;

  async connect(config: SftpConfig): Promise<void> {
    this.client = new SftpClientLib();
    
    try {
      await this.client.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        privateKey: config.privateKey,
        readyTimeout: 30000,
        retries: 2,
        retry_factor: 2,
        retry_minTimeout: 2000,
      });
      console.log('SFTP connection established');
    } catch (error) {
      console.error('SFTP connection error:', error);
      throw error;
    }
  }

  async listFiles(remotePath: string): Promise<FileInfo[]> {
    if (!this.client) throw new Error('Not connected');

    try {
      const list = await this.client.list(remotePath);
      
      return list
        .filter((item: any) => item.type === '-')
        .map((item: any) => ({
          name: item.name,
          type: item.type,
          size: item.size,
          modifyTime: item.modifyTime,
        }));
    } catch (error) {
      console.error('List files error:', error);
      return [];
    }
  }

  async downloadFile(remotePath: string): Promise<string> {
    if (!this.client) throw new Error('Not connected');

    try {
      const buffer = await this.client.get(remotePath);
      return buffer.toString('utf-8');
    } catch (error) {
      console.error('Download error:', error);
      throw error;
    }
  }

  async uploadFile(remotePath: string, content: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');

    try {
      const buffer = Buffer.from(content, 'utf-8');
      await this.client.put(buffer, remotePath);
      console.log(`File uploaded: ${remotePath}`);
    } catch (error) {
      console.error('Upload error:', error);
      throw error;
    }
  }

  async moveFile(fromPath: string, toPath: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');

    try {
      await this.client.rename(fromPath, toPath);
      console.log(`File moved: ${fromPath} → ${toPath}`);
    } catch (error) {
      console.error('Move error:', error);
      throw error;
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');

    try {
      await this.client.delete(remotePath);
      console.log(`File deleted: ${remotePath}`);
    } catch (error) {
      console.error('Delete error:', error);
      throw error;
    }
  }

  async ensureDir(remotePath: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');

    try {
      await this.client.mkdir(remotePath, true);
      console.log(`Directory created: ${remotePath}`);
    } catch (error) {
      // Directory might already exist
      console.log(`Directory already exists or created: ${remotePath}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.end();
        console.log('SFTP connection closed');
      } catch (error) {
        console.error('Disconnect error:', error);
      }
      this.client = null;
    }
  }
}
