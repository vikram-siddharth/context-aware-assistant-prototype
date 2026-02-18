import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum MemoryCategory {
  CONSTRAINT = 'constraint',
  PREFERENCE = 'preference',
  GOAL = 'goal',
}

export enum MemoryPersistence {
  PERMANENT = 'permanent',
  LONG_TERM = 'long_term',
  SHORT_TERM = 'short_term',
}

@Entity('memories')
export class Memory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  fact: string;

  @Column({
    type: 'enum',
    enum: MemoryCategory,
  })
  category: MemoryCategory;

  @Column({
    type: 'enum',
    enum: MemoryPersistence,
  })
  persistence: MemoryPersistence;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn()
  created_at: Date;
}
